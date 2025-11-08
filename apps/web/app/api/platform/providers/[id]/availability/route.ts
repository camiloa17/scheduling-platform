import type { Params } from "app/_types";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { parseRequestData } from "app/api/parseRequestData";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import type { Dayjs } from "@calcom/dayjs";
import { getUserAvailabilityService } from "@calcom/lib/di/containers/GetUserAvailability";
import { prisma } from "@calcom/prisma";

const querySchema = z.object({
  dateFrom: z.string().min(1, "dateFrom is required"),
  dateTo: z.string().min(1, "dateTo is required"),
  eventTypeId: z.coerce.number().int().positive().optional(),
  duration: z.coerce.number().int().positive().optional(),
});

function toIsoRange(range: { start: Dayjs; end: Dayjs }) {
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  };
}

function toIsoDateRange(range: { start: Date; end: Date }) {
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  };
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

const dateOverrideSchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});

const availabilitySchema = z.object({
  schedules: z.array(
    z.object({
      name: z.string().default("Working Hours"),
      availability: z.array(
        z.object({
          days: z.array(z.number().min(0).max(6)),
          startTime: z.string(), // "09:00"
          endTime: z.string(), // "17:00"
        })
      ),
      dateOverrides: z.array(dateOverrideSchema).optional(),
    })
  ),
});

async function getHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;

  if (typeof id !== "string") {
    return NextResponse.json({ error: "id is not a string" }, { status: 400 });
  }

  const providerId = parseInt(id, 10);
  if (!Number.isFinite(providerId) || providerId <= 0) {
    return NextResponse.json({ error: "Invalid provider ID" }, { status: 400 });
  }

  const searchParams = Object.fromEntries(req.nextUrl.searchParams.entries());
  const { dateFrom, dateTo, eventTypeId, duration } = querySchema.parse(searchParams);

  const userAvailabilityService = getUserAvailabilityService();
  const availability = await userAvailabilityService.getUserAvailability({
    userId: providerId,
    dateFrom,
    dateTo,
    eventTypeId,
    duration,
    returnDateOverrides: true,
    bypassBusyCalendarTimes: false,
  });

  const responsePayload = {
    providerId,
    timeZone: availability.timeZone,
    availability: availability.dateRanges.map((range) => toIsoRange(range)),
    availabilityExcludingOutOfOffice: availability.oooExcludedDateRanges.map((range) => toIsoRange(range)),
    overrides: availability.dateOverrides.map((range) => toIsoDateRange(range)),
    workingHours: availability.workingHours.map((hours) => ({
      days: hours.days,
      startTime: minutesToTime(hours.startTime),
      endTime: minutesToTime(hours.endTime),
    })),
    busy: availability.busy.map((busy) => ({
      start: busy.start,
      end: busy.end,
      title: busy.title,
      source: busy.source,
    })),
    datesOutOfOffice: availability.datesOutOfOffice,
    currentSeats: availability.currentSeats,
  };

  return NextResponse.json(responsePayload);
}

async function postHandler(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  if (typeof id !== "string") {
    return NextResponse.json({ error: "id is not a string" }, { status: 400 });
  }
  const providerId = parseInt(id);
  if (isNaN(providerId) || providerId <= 0) {
    return NextResponse.json({ error: "Invalid provider ID" }, { status: 400 });
  }
  const body = await parseRequestData(req);
  const data = availabilitySchema.parse(body);

  await prisma.availability.deleteMany({
    where: { userId: providerId },
  });

  // Clear existing schedules
  await prisma.schedule.deleteMany({
    where: { userId: providerId },
  });

  const user = await prisma.user.findUnique({
    where: { id: providerId },
    select: { timeZone: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Create new schedules
  for (const schedule of data.schedules) {
    const overrides = schedule.dateOverrides ?? [];
    const overrideAvailability = overrides.map((override) => {
      return {
        date: new Date(override.start),
        startTime: new Date(override.start),
        endTime: new Date(override.end),
        userId: providerId,
      };
    });
    const weeklyAvailability = schedule.availability.map((slot) => {
      const [startHour, startMin] = slot.startTime.split(":").map(Number);
      const [endHour, endMin] = slot.endTime.split(":").map(Number);

      // Remove the offset adjustment - just store the naive time
      return {
        days: slot.days,
        startTime: new Date(Date.UTC(1970, 0, 1, startHour, startMin, 0)),
        endTime: new Date(Date.UTC(1970, 0, 1, endHour, endMin, 0)),
        userId: providerId,
      };
    });

    const availabilityEntries = [...weeklyAvailability, ...overrideAvailability];
    const createdSchedule = await prisma.schedule.create({
      data: {
        name: schedule.name,
        userId: providerId,
        timeZone: user.timeZone,
        availability: availabilityEntries.length
          ? {
              create: availabilityEntries,
            }
          : undefined,
      },
    });

    await prisma.user.update({
      where: { id: providerId },
      data: { defaultScheduleId: createdSchedule.id },
    });
  }

  return NextResponse.json({ success: true });
}

export const GET = defaultResponderForAppDir(getHandler);
export const POST = defaultResponderForAppDir(postHandler);
