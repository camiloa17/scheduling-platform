import { getAttributesAssignmentData } from "@calcom/lib/service/attribute/server/getAttributes";
import type { Attribute } from "@calcom/lib/service/attribute/server/getAttributes";

import type { dynamicFieldValueOperands } from "./types";
import type { AttributesQueryValue } from "./types";

type TeamMemberWithAttributeOptionValuePerAttribute = Awaited<
  ReturnType<typeof getAttributesAssignmentData>
>["attributesAssignedToTeamMembersWithOptions"][number];

type RunAttributeLogicData = {
  attributesQueryValue: AttributesQueryValue | null;
  attributesData: {
    attributesOfTheOrg: Attribute[];
    teamMembersWithAttributeOptionValuePerAttribute: TeamMemberWithAttributeOptionValuePerAttribute[];
  };
  dynamicFieldValueOperands?: dynamicFieldValueOperands;
};

type RunAttributeLogicOptions = {
  enableTroubleshooter: boolean;
};

export const enum TroubleshooterCase {
  IS_A_ROUTER = "is-a-router",
  NO_LOGIC_FOUND = "no-logic-found",
  MATCH_RESULTS_READY = "match-results-ready",
  MATCH_RESULTS_READY_WITH_FALLBACK = "match-results-ready-with-fallback",
  MATCHES_ALL_MEMBERS_BECAUSE_OF_EMPTY_QUERY_VALUE = "matches-all-members-because-of-empty-query-value",
  MATCHES_ALL_MEMBERS = "matches-all-members",
}

async function asyncPerf<ReturnValue>(fn: () => Promise<ReturnValue>): Promise<[ReturnValue, number | null]> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  return [result, end - start];
}

function buildTroubleshooterData({ type, data }: { type: TroubleshooterCase; data: Record<string, any> }) {
  return {
    troubleshooter: {
      type,
      data,
    },
  };
}

async function runAttributeLogic(data: RunAttributeLogicData, options: RunAttributeLogicOptions) {
  const { enableTroubleshooter } = options;
  const {
    attributesData: { attributesOfTheOrg, teamMembersWithAttributeOptionValuePerAttribute },
    attributesQueryValue,
  } = data;

  const shouldWarnAboutMissingLogic = Boolean(attributesQueryValue);

  return {
    logicBuildingWarnings: shouldWarnAboutMissingLogic
      ? ["Attribute routing logic evaluation is disabled in this deployment."]
      : [],
    teamMembersMatchingAttributeLogic: null,
    timeTaken: null,
    ...(enableTroubleshooter
      ? buildTroubleshooterData({
          type: TroubleshooterCase.NO_LOGIC_FOUND,
          data: {
            reason: "Attribute routing logic disabled on server.",
            attributesOfTheOrg,
            teamMembersWithAttributeOptionValuePerAttribute,
          },
        })
      : null),
  };
}

export async function getAttributesForLogic({ teamId, orgId }: { teamId: number; orgId: number }) {
  const [result, ttAttributes] = await asyncPerf(async () => {
    return getAttributesAssignmentData({ teamId, orgId });
  });

  return {
    attributesOfTheOrg: result.attributesOfTheOrg,
    teamMembersWithAttributeOptionValuePerAttribute: result.attributesAssignedToTeamMembersWithOptions,
    timeTaken: ttAttributes,
  };
}

export async function findTeamMembersMatchingAttributeLogic(
  data: {
    teamId: number;
    orgId: number;
    attributesQueryValue: AttributesQueryValue | null;
    fallbackAttributesQueryValue?: AttributesQueryValue | null;
    dynamicFieldValueOperands?: dynamicFieldValueOperands;
    isPreview?: boolean;
  },
  options: {
    enablePerf?: boolean;
    concurrency?: number;
    enableTroubleshooter?: boolean;
  } = {}
) {
  const { enableTroubleshooter = false } = options;

  const { teamId, orgId } = data;

  const {
    attributesOfTheOrg,
    teamMembersWithAttributeOptionValuePerAttribute,
    timeTaken: ttGetAttributesForLogic,
  } = await getAttributesForLogic({
    teamId,
    orgId,
  });

  const runAttributeLogicData: RunAttributeLogicData = {
    attributesQueryValue: data.attributesQueryValue,
    attributesData: {
      attributesOfTheOrg,
      teamMembersWithAttributeOptionValuePerAttribute,
    },
    dynamicFieldValueOperands: data.dynamicFieldValueOperands,
  };

  const { teamMembersMatchingAttributeLogic, logicBuildingWarnings, timeTaken, troubleshooter } =
    await runAttributeLogic(runAttributeLogicData, { enableTroubleshooter });

  return {
    teamMembersMatchingAttributeLogic,
    checkedFallback: false,
    mainAttributeLogicBuildingWarnings: logicBuildingWarnings ?? [],
    fallbackAttributeLogicBuildingWarnings: [],
    timeTaken: {
      ttGetAttributesForLogic,
      ...(timeTaken ?? {}),
    },
    ...(troubleshooter ?? {}),
  };
}
