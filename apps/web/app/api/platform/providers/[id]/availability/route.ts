import type { Params } from "app/_types";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { NextResponse, type NextRequest } from "next/server";
import type { Dayjs } from "@calcom/dayjs";
import { getUserAvailabilityService } from "@calcom/lib/di/containers/GetUserAvailability";
import { z } from "zod";

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
      startTimeMinutes: hours.startTime,
      endTimeMinutes: hours.endTime,
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

export const GET = defaultResponderForAppDir(getHandler);
