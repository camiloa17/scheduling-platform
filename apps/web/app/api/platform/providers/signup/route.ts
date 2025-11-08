import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { parseRequestData } from "app/api/parseRequestData";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { emailRegex } from "@calcom/lib/emailSchema";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import slugify from "@calcom/lib/slugify";
import { prisma } from "@calcom/prisma";
import { IdentityProvider } from "@calcom/prisma/enums";

export const providerSignupSchema = z.object({
  email: z.string().regex(emailRegex, { message: "Invalid email" }),
  name: z.string(),
  // No password, no other user types - just providers
});

const EVENT_DURATION_OPTIONS = [45, 60, 90];

const EVENT_DEFINITIONS = [
  {
    title: "OneOnOne",
    slugBase: "one-on-one",
    description: "One-on-one provider session",
  },
  {
    title: "DiscoveryCall",
    slugBase: "discovery-call",
    description: "Initial discovery call to understand requester's goals",
  },
  {
    title: "ActionPlan",
    slugBase: "action-plan",
    description: "Follow-up focused on creating an actionable plan",
  },
];

const INTERNAL_CALENDAR_INTEGRATION = "caldav_calendar";

async function handler(req: NextRequest) {
  let body = {};
  try {
    body = await parseRequestData(req);
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ message: e.message }, { status: e.statusCode });
    }
    logger.error(e);
    return NextResponse.json({ message: "Internal server error" }, { status: 500 });
  }
  const providerData = providerSignupSchema.parse(body);

  const userEmail = providerData.email.toLowerCase();

  return handleProviderSignup({
    name: providerData.name,
    email: userEmail,
  });
}

async function handleProviderSignup({ email, name }: { email: string; name: string }) {
  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    // Find all user events types
    const eventTypes = await prisma.eventType.findMany({
      where: { userId: existingUser.id },
    });
    return NextResponse.json({
      message: "Provider already exists",
      provider: {
        id: existingUser.id,
        email: existingUser.email,
        username: existingUser.username,
        name: existingUser.name,
      },
      eventTypes: eventTypes.map((eventType) => ({
        id: eventType.id,
        slug: eventType.slug,
        title: eventType.title,
        length: eventType.length,
        durations: EVENT_DURATION_OPTIONS,
      })),
    });
  }

  const tempUsername = `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const result = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({
      data: {
        username: tempUsername,
        email,
        name,
        emailVerified: new Date(),
        identityProvider: IdentityProvider.CAL,
      },
    });

    const finalUsernameBase = slugify(`${name}-${createdUser.id}`) || `provider-${createdUser.id}`;

    const provider = await tx.user.update({
      where: { id: createdUser.id },
      data: { username: finalUsernameBase },
    });

    const eventTypes = await Promise.all(
      EVENT_DEFINITIONS.map((definition) => {
        const slug = `${definition.slugBase}-${provider.id}`;

        return tx.eventType.create({
          data: {
            userId: provider.id,
            title: definition.title,
            slug,
            description: definition.description,
            length: 60,
            metadata: {
              multipleDuration: EVENT_DURATION_OPTIONS,
            },
            hosts: {
              create: {
                userId: provider.id,
              },
            },
            users: {
              connect: {
                id: provider.id,
              },
            },
          },
        });
      })
    );

    const calendarExternalId = `provider-${provider.id}-calendar`;

    const destinationCalendar = await tx.destinationCalendar.create({
      data: {
        userId: provider.id,
        integration: INTERNAL_CALENDAR_INTEGRATION,
        externalId: calendarExternalId,
        primaryEmail: provider.email,
      },
    });

    await tx.selectedCalendar.create({
      data: {
        userId: provider.id,
        integration: INTERNAL_CALENDAR_INTEGRATION,
        externalId: calendarExternalId,
      },
    });

    return { provider, eventTypes, destinationCalendar };
  });

  return NextResponse.json(
    {
      message: "Provider created successfully",
      provider: {
        id: result.provider.id,
        email: result.provider.email,
        username: result.provider.username,
        name: result.provider.name,
      },
      eventTypes: result.eventTypes.map((eventType) => ({
        id: eventType.id,
        slug: eventType.slug,
        title: eventType.title,
        length: eventType.length,
        durations: EVENT_DURATION_OPTIONS,
      })),
      destinationCalendar: {
        id: result.destinationCalendar.id,
        integration: result.destinationCalendar.integration,
        externalId: result.destinationCalendar.externalId,
      },
    },
    { status: 201 }
  );
}

export const POST = defaultResponderForAppDir(handler);
