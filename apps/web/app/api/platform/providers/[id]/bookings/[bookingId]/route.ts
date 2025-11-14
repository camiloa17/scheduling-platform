import type { Params } from "app/_types";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { prisma } from "@calcom/prisma";

async function getHandler(_req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id, bookingId } = await params;

  if (typeof id !== "string") {
    return NextResponse.json({ error: "id is not a string" }, { status: 400 });
  }

  const providerId = parseInt(id, 10);
  if (!Number.isFinite(providerId) || providerId <= 0) {
    return NextResponse.json({ error: "Invalid provider ID" }, { status: 400 });
  }

  if (typeof bookingId !== "string") {
    return NextResponse.json({ error: "bookingId is not a string" }, { status: 400 });
  }

  const booking = await prisma.booking.findFirst({
    where: {
      uid: bookingId,
      userId: providerId,
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  return NextResponse.json({ booking });
}

async function deleteHandler(_req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id, bookingId } = await params;

  if (typeof id !== "string") {
    return NextResponse.json({ error: "id is not a string" }, { status: 400 });
  }

  const providerId = parseInt(id, 10);
  if (!Number.isFinite(providerId) || providerId <= 0) {
    return NextResponse.json({ error: "Invalid provider ID" }, { status: 400 });
  }

  if (typeof bookingId !== "string") {
    return NextResponse.json({ error: "bookingId is not a string" }, { status: 400 });
  }

  const deletedBooking = await prisma.booking.deleteMany({
    where: {
      uid: bookingId,
      userId: providerId,
    },
  });

  if (deletedBooking.count === 0) {
    return NextResponse.json({ error: "Booking not found or could not be deleted" }, { status: 404 });
  }

  return NextResponse.json({ message: "Booking deleted successfully" });
}

export const GET = getHandler;
export const DELETE = deleteHandler;
