import type { Params } from "app/_types";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { parseRequestData } from "app/api/parseRequestData";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import dayjs from "@calcom/dayjs";
import handleNewBooking from "@calcom/features/bookings/lib/handleNewBooking";
import { getUserAvailabilityService } from "@calcom/lib/di/containers/GetUserAvailability";
import { HttpError } from "@calcom/lib/http-error";
import { prisma } from "@calcom/prisma";
import { CreationSource } from "@calcom/prisma/enums";

type LocationPayload = {
  optionValue: string;
  value: string;
};

const bookingRequestSchema = z.object({
  eventTypeId: z.coerce.number().int().positive(),
  start: z.string().min(1, "start is required"),
  end: z.string().optional(),
  timeZone: z.string().min(1, "timeZone is required"),
  language: z.string().min(2).default("en"),
  durationMinutes: z.coerce.number().int().positive().optional(),
  metadata: z.record(z.string()).default({}),
  responses: z.object({
    email: z.string().email(),
    name: z.string().min(1, "name is required"),
    guests: z.array(z.string().email()).optional(),
    notes: z.string().optional(),
    location: z
      .object({
        optionValue: z.string().default(""),
        value: z.string().min(1, "location value is required"),
      })
      .optional(),
    smsReminderNumber: z.string().optional(),
    attendeePhoneNumber: z.string().optional(),
  }),
});

async function postHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;

  if (typeof id !== "string") {
    return NextResponse.json({ error: "id is not a string" }, { status: 400 });
  }

  const providerId = parseInt(id, 10);
  if (!Number.isFinite(providerId) || providerId <= 0) {
    return NextResponse.json({ error: "Invalid provider ID" }, { status: 400 });
  }

  const body = await parseRequestData(req);
  const data = bookingRequestSchema.parse(body);

  const provider = await prisma.user.findUnique({
    where: { id: providerId },
    select: { id: true, username: true },
  });

  if (!provider) {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }

  const eventType = await prisma.eventType.findFirst({
    where: {
      id: data.eventTypeId,
      hosts: { some: { userId: providerId } },
    },
    select: {
      id: true,
      slug: true,
      length: true,
      metadata: true,
      seatsPerTimeSlot: true,
      hosts: {
        select: {
          user: {
            select: {
              username: true,
            },
          },
        },
      },
    },
  });

  if (!eventType) {
    return NextResponse.json({ error: "Event type not found for provider" }, { status: 404 });
  }

  if (eventType.seatsPerTimeSlot && eventType.seatsPerTimeSlot > 1) {
    return NextResponse.json({ error: "Event type is not configured for 1-on-1 bookings" }, { status: 400 });
  }

  const start = dayjs(data.start);
  if (!start.isValid()) {
    return NextResponse.json({ error: "Invalid start time" }, { status: 400 });
  }

  const eventMetadata = (eventType.metadata as { multipleDuration?: unknown } | null) ?? null;
  const allowedDurations = Array.isArray(eventMetadata?.multipleDuration)
    ? eventMetadata.multipleDuration.filter(
        (value): value is number => typeof value === "number" && value > 0
      )
    : null;

  let durationToUse: number;
  let computedEnd: dayjs.Dayjs;

  if (data.durationMinutes !== undefined) {
    if (data.durationMinutes <= 0) {
      return NextResponse.json({ error: "Duration must be positive" }, { status: 400 });
    }
    durationToUse = data.durationMinutes;
    computedEnd = start.add(durationToUse, "minute");
  } else if (data.end) {
    computedEnd = dayjs(data.end);
    if (!computedEnd.isValid()) {
      return NextResponse.json({ error: "Invalid end time" }, { status: 400 });
    }
    durationToUse = computedEnd.diff(start, "minute");
  } else {
    durationToUse = eventType.length;
    computedEnd = start.add(durationToUse, "minute");
  }

  if (!computedEnd.isValid()) {
    return NextResponse.json({ error: "Invalid end time" }, { status: 400 });
  }

  if (!computedEnd.isAfter(start)) {
    return NextResponse.json({ error: "End time must be after start time" }, { status: 400 });
  }

  if (durationToUse <= 0 || !Number.isInteger(durationToUse)) {
    return NextResponse.json({ error: "Duration must be a positive integer" }, { status: 400 });
  }

  if (allowedDurations && allowedDurations.length > 0 && !allowedDurations.includes(durationToUse)) {
    return NextResponse.json(
      {
        error: `Requested duration ${durationToUse} not available for this event`,
        requestedDuration: durationToUse,
        allowedDurations,
      },
      { status: 400 }
    );
  }

  const hostUsernames = eventType.hosts
    .map((host) => host.user?.username)
    .filter((username): username is string => Boolean(username));

  if (hostUsernames.length === 0) {
    return NextResponse.json({ error: "Provider does not have a username configured" }, { status: 400 });
  }

  const availabilityService = getUserAvailabilityService();
  const availability = await availabilityService.getUserAvailability({
    userId: providerId,
    eventTypeId: eventType.id,
    dateFrom: start.startOf("day").toISOString(),
    dateTo: computedEnd.endOf("day").toISOString(),
    duration: durationToUse,
    returnDateOverrides: true,
    bypassBusyCalendarTimes: false,
  });

  const slotAvailable = availability.dateRanges.some((range) => {
    const rangeStart = dayjs(range.start);
    const rangeEnd = dayjs(range.end);
    return !start.isBefore(rangeStart) && !computedEnd.isAfter(rangeEnd);
  });

  if (!slotAvailable) {
    return NextResponse.json(
      { error: "Provider is no longer available for the requested time" },
      { status: 409 }
    );
  }

  const bookingData = {
    eventTypeId: eventType.id,
    eventTypeSlug: eventType.slug ?? undefined,
    start: start.toISOString(),
    end: computedEnd.toISOString(),
    timeZone: data.timeZone,
    language: data.language,
    user: hostUsernames.length === 1 ? hostUsernames[0] : hostUsernames,
    metadata: data.metadata,
    hasHashedBookingLink: false,
    hashedLink: null,
    responses: {
      email: data.responses.email,
      name: data.responses.name,
      guests: data.responses.guests,
      notes: data.responses.notes,
      location: data.responses.location as LocationPayload | undefined,
      smsReminderNumber: data.responses.smsReminderNumber,
      attendeePhoneNumber: data.responses.attendeePhoneNumber,
    },
    creationSource: CreationSource.API_V2,
  };

  try {
    const booking = await handleNewBooking({
      bookingData,
      userId: -1,
      hostname: req.headers.get("host") ?? "",
      areCalendarEventsEnabled: true,
    });

    return NextResponse.json({
      bookingId: booking.id ?? null,
      bookingUid: booking.uid ?? null,
      providerId,
      eventTypeId: booking.eventTypeId ?? eventType.id,
      startTime:
        booking.startTime instanceof Date
          ? booking.startTime.toISOString()
          : typeof booking.startTime === "string"
          ? booking.startTime
          : null,
      endTime:
        booking.endTime instanceof Date
          ? booking.endTime.toISOString()
          : typeof booking.endTime === "string"
          ? booking.endTime
          : null,
      status: booking.status ?? null,
      durationMinutes: durationToUse,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }

    throw error;
  }
}

export const POST = defaultResponderForAppDir(postHandler);
