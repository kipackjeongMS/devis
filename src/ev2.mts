// Ev2 ("Express v2" / Azure Service Deploy) rollout client for the Rollouts view.
//
// This is a deliberately lightweight re-implementation of the ReleaseDashboard
// (msazure/Azure AppConfig/ReleaseDashboard) capability. That app needs a whole
// ASP.NET + MSAL + Entra-app + KeyVault-cert + on-behalf-of stack just to reach
// the Ev2 REST API. We reach the same API with the local user's `az` login —
// exactly the pattern ado.mts already uses — so the entire auth stack disappears.
//
// Fetch tiering (the "lightweight" part):
//   - LIST   /api/rollouts .................. rollout ids + start times (cheap).
//   - DETAIL /api/rollouts/{id} ............. ~17KB, real Status/Build/Env; used
//                                             to enrich the list into status badges.
//   - DETAIL /api/rollouts/{id}?embed-detail  ~2.8MB full region tree; fetched
//                                             LAZILY only when a rollout is expanded.
// (ReleaseDashboard eagerly pulls the 2.8MB embed detail for every rollout.)
//
// Dependency-free: node built-ins + the shared az-token helper only.

import https from "node:https";
import { getAzToken } from "./azauth.mjs";

// ---------------------------------------------------------------------------
// Ported configuration (from ReleaseDashboard appsettings.json)
// ---------------------------------------------------------------------------
const ROLLOUT_INFRA = "azureservicedeploy.msft.net";
const EV2_RESOURCE = `https://${ROLLOUT_INFRA}`; // token audience
const API_VERSION = "2016-07-01";
const SERVICE_IDENTIFIER = "45a7d954-eede-467d-b4f9-1f77feeec23c";
const LOOKBACK_DAYS = 21;
const ENRICH_CONCURRENCY = 12;

export const SERVICE_GROUPS: string[] = [
    "Microsoft.Azure.AppConfiguration.ACSAgent",
    "Microsoft.Azure.AppConfiguration.AppConfigService",
    "Microsoft.Azure.AppConfiguration.GenevaAction",
    "Microsoft.Azure.AppConfiguration.Infrastructure",
    "Microsoft.Azure.AppConfiguration.Notification",
    "Microsoft.Azure.AppConfiguration.Patch",
    "Microsoft.Azure.AppConfiguration.Replication",
    "Microsoft.Azure.AppConfiguration.ResourceProvider",
    "Microsoft.Azure.AppConfiguration.RPAgent",
    "Microsoft.Azure.AppConfiguration.Runner",
    "Microsoft.Azure.AppConfiguration.Statistics",
];

interface StageConfig {
    name: string;
    regions: string[];
}

// "REMAINING_REGIONS" is a catch-all: any deployed region not named by an
// earlier stage falls into that stage (ported behavior; unused by default).
const STAGES: StageConfig[] = [
    { name: "Stage 1", regions: ["eastus2euap"] },
    { name: "Stage 2", regions: ["canadacentral", "francecentral", "westcentralus", "mexicocentral"] },
    {
        name: "Stage 3",
        regions: [
            "australiacentral2", "australiasoutheast", "brazilsoutheast", "centralindia",
            "eastus", "eastus2", "germanynorth", "japanwest", "koreasouth", "northcentralus",
            "northeurope", "norwayeast", "qatarcentral", "southafricanorth", "southeastasia",
            "swedensouth", "switzerlandnorth", "taiwannorthwest", "uksouth", "jioindiacentral",
            "uaecentral", "newzealandnorth", "malaysiawest", "chilecentral", "southcentralus2",
            "indonesiacentral",
        ],
    },
    {
        name: "Stage 4",
        regions: [
            "australiacentral", "australiaeast", "brazilsouth", "canadaeast", "centralus",
            "eastasia", "francesouth", "germanywestcentral", "israelcentral", "italynorth",
            "japaneast", "jioindiawest", "koreacentral", "norwaywest", "polandcentral",
            "southafricawest", "southcentralus", "southindia", "spaincentral", "swedencentral",
            "switzerlandwest", "taiwannorth", "uaenorth", "ukwest", "westeurope", "westus",
            "westus2", "westus3",
        ],
    },
];

const REMAINING = "REMAINING_REGIONS";

// ---------------------------------------------------------------------------
// Public data shapes (mirrored, independently, by the frontend)
// ---------------------------------------------------------------------------
export interface RolloutSummary {
    serviceGroup: string;
    id: string;
    status: string;
    startTime: string | null;
    buildVersion: string | null;
    environment: string | null;
    url: string;
}

export interface ServiceGroupRollouts {
    name: string;
    rollouts: RolloutSummary[];
}

export interface RegionInfo {
    name: string;
    status: string;
    startTime: string | null;
    endTime: string | null;
}

export interface StageInfo {
    name: string;
    regions: RegionInfo[];
}

// The lazily-loaded stage/region grid for a single rollout.
export interface RolloutGrid {
    id: string;
    status: string;
    buildVersion: string | null;
    environment: string | null;
    url: string;
    stages: StageInfo[];
}

// ---------------------------------------------------------------------------
// Raw Ev2 shapes (only the fields we read)
// ---------------------------------------------------------------------------
interface RawActionOp {
    StartTime?: string;
    EndTime?: string;
}
interface RawAction {
    Status?: string;
    ActionOperationInfo?: RawActionOp;
}
interface RawResource {
    Actions?: RawAction[];
}
interface RawResourceGroup {
    Location?: string;
    Resources?: RawResource[];
}
interface RawRolloutDetails {
    Environment?: string;
    BuildVersion?: string;
}
interface RawRolloutOpInfo {
    StartTime?: string;
}
interface RawRollout {
    RolloutId: string;
    Status?: string;
    RolloutDetails?: RawRolloutDetails;
    RolloutOperationInfo?: RawRolloutOpInfo;
    ResourceGroups?: RawResourceGroup[];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function ev2GetRaw(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        getAzToken(EV2_RESOURCE).then((token) => {
            const req = https.request(
                `https://${ROLLOUT_INFRA}${path}`,
                {
                    method: "GET",
                    headers: { Authorization: "Bearer" + " " + token },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        const status = res.statusCode || 0;
                        if (status < 200 || status >= 300) {
                            reject(new Error(`Ev2 GET ${status}: ${text.slice(0, 300)}`));
                        } else {
                            resolve(text);
                        }
                    });
                },
            );
            req.on("error", reject);
            req.end();
        }, reject);
    });
}

async function ev2GetJson<T>(path: string): Promise<T> {
    const text = await ev2GetRaw(path);
    return JSON.parse(text) as T;
}

const enc = encodeURIComponent;

function portalUrl(environment: string | null | undefined, serviceGroup: string, rolloutId: string): string {
    return `https://ra.ev2portal.azure.net/#/rollouts/${environment || "Prod"}/${SERVICE_IDENTIFIER}/${serviceGroup}/${rolloutId}`;
}

// ---------------------------------------------------------------------------
// Time helpers — treat missing / .NET DateTimeOffset.MinValue as "no time"
// ---------------------------------------------------------------------------
function validTimeMs(s: string | undefined): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    if (new Date(t).getUTCFullYear() <= 1) return null; // 0001-01-01… => none
    return t;
}

// ---------------------------------------------------------------------------
// List (summaries) — the enriched dashboard
// ---------------------------------------------------------------------------
async function listRawRollouts(serviceGroup: string): Promise<RawRollout[]> {
    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const path =
        `/api/rollouts?servicegroupname=${enc(serviceGroup)}` +
        `&startTimeFrom=${enc(from.toISOString())}` +
        `&startTimeTo=${enc(to.toISOString())}` +
        `&api-version=${API_VERSION}`;
    return (await ev2GetJson<RawRollout[]>(path)) || [];
}

// Non-embed detail: cheap (~17KB) and carries the real Status/Build/Environment
// that the list endpoint omits (list Status is always "None").
async function enrichSummary(serviceGroup: string, raw: RawRollout): Promise<RolloutSummary> {
    const path =
        `/api/rollouts/${enc(raw.RolloutId)}?servicegroupname=${enc(serviceGroup)}` +
        `&api-version=${API_VERSION}`;
    let status = raw.Status || "Unknown";
    let buildVersion: string | null = null;
    let environment: string | null = null;
    try {
        const d = await ev2GetJson<RawRollout>(path);
        status = d.Status || status;
        buildVersion = d.RolloutDetails?.BuildVersion || null;
        environment = d.RolloutDetails?.Environment || null;
    } catch {
        /* keep the (unreliable) list status if the detail call fails */
    }
    return {
        serviceGroup,
        id: raw.RolloutId,
        status,
        startTime: raw.RolloutOperationInfo?.StartTime || null,
        buildVersion,
        environment,
        url: portalUrl(environment, serviceGroup, raw.RolloutId),
    };
}

// Bounded-concurrency map so ~30 enrich calls don't fan out unbounded.
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    async function worker(): Promise<void> {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

// All configured service groups, each with its recent rollouts (status-enriched).
export async function getServiceGroupRollouts(): Promise<{
    serviceGroups: ServiceGroupRollouts[];
    errors: string[];
}> {
    const errors: string[] = [];

    // 1) list every service group in parallel -> flat (serviceGroup, raw) tuples.
    const listed = await Promise.all(
        SERVICE_GROUPS.map(async (sg) => {
            try {
                return { sg, raws: await listRawRollouts(sg) };
            } catch (e) {
                errors.push(`${sg}: ${(e as Error).message}`);
                return { sg, raws: [] as RawRollout[] };
            }
        }),
    );
    const tuples = listed.flatMap(({ sg, raws }) => raws.map((raw) => ({ sg, raw })));

    // 2) enrich every rollout with the cheap non-embed detail (capped concurrency).
    const summaries = await mapLimit(tuples, ENRICH_CONCURRENCY, ({ sg, raw }) => enrichSummary(sg, raw));

    // 3) regroup by service group, newest first.
    const byGroup = new Map<string, RolloutSummary[]>();
    for (const sg of SERVICE_GROUPS) byGroup.set(sg, []);
    for (const s of summaries) byGroup.get(s.serviceGroup)!.push(s);

    const serviceGroups: ServiceGroupRollouts[] = SERVICE_GROUPS.map((name) => {
        const rollouts = (byGroup.get(name) || []).sort(
            (a, b) => (validTimeMs(b.startTime || undefined) || 0) - (validTimeMs(a.startTime || undefined) || 0),
        );
        return { name, rollouts };
    });

    return { serviceGroups, errors };
}

// ---------------------------------------------------------------------------
// Detail (embed) -> Stage/Region grid  (ported RolloutService transform)
// ---------------------------------------------------------------------------
export async function getRolloutGrid(serviceGroup: string, rolloutId: string): Promise<RolloutGrid> {
    const path =
        `/api/rollouts/${enc(rolloutId)}?servicegroupname=${enc(serviceGroup)}` +
        `&api-version=${API_VERSION}&embed-detail=true`;
    const rollout = await ev2GetJson<RawRollout>(path);

    const environment = rollout.RolloutDetails?.Environment || null;
    const buildVersion = rollout.RolloutDetails?.BuildVersion || null;

    // Group deployed resource groups by region — CASE-INSENSITIVE (Ev2 returns
    // PascalCase like "EastUS2Euap"; stage config is lowercase). This is the
    // latent bug the C# ordinal Dictionary has.
    const locationMap = new Map<string, RawResourceGroup[]>();
    for (const rg of rollout.ResourceGroups || []) {
        const key = (rg.Location || "").toLowerCase();
        if (!key) continue;
        const list = locationMap.get(key);
        if (list) list.push(rg);
        else locationMap.set(key, [rg]);
    }

    const stages: StageInfo[] = [];
    const accountedFor = new Set<string>(); // lowercase region keys already placed
    for (const stage of STAGES) {
        let regionNames: string[];
        if (stage.regions.includes(REMAINING)) {
            regionNames = [...locationMap.keys()].filter((k) => !accountedFor.has(k));
        } else {
            regionNames = stage.regions;
        }
        const regions = regionNames.map((r) => buildRegionInfo(r, locationMap));
        normalizeCheckInProgress(regions);
        for (const r of regionNames) accountedFor.add(r.toLowerCase());
        stages.push({ name: stage.name, regions });
    }

    return {
        id: rolloutId,
        status: rollout.Status || "Unknown",
        buildVersion,
        environment,
        url: portalUrl(environment, serviceGroup, rolloutId),
        stages,
    };
}

// Per-region status/timing from its resource-group action tree.
// Ported from RolloutService.BuildRegionDisplayInfo: the last non-succeeded
// action wins the status; otherwise "Succeeded" with min-start / max-end.
function buildRegionInfo(regionName: string, locationMap: Map<string, RawResourceGroup[]>): RegionInfo {
    const key = regionName.toLowerCase();
    const groups = locationMap.get(key);
    if (!groups) {
        return { name: regionName, status: "Not Started", startTime: null, endTime: null };
    }

    let failedStatus: string | null = null;
    let failedStart: string | null = null;
    let failedEnd: string | null = null;
    let minStart: number | null = null;
    let maxEnd: number | null = null;

    for (const rg of groups) {
        for (const resource of rg.Resources || []) {
            for (const action of resource.Actions || []) {
                if ((action.Status || "") !== "Succeeded") {
                    failedStatus = action.Status || "Unknown";
                    failedStart = action.ActionOperationInfo?.StartTime || null;
                    failedEnd = action.ActionOperationInfo?.EndTime || null;
                    break; // matches the C# inner-loop break (per resource)
                }
                const end = validTimeMs(action.ActionOperationInfo?.EndTime);
                if (end !== null && (maxEnd === null || end > maxEnd)) maxEnd = end;
                const start = validTimeMs(action.ActionOperationInfo?.StartTime);
                if (start !== null && (minStart === null || start < minStart)) minStart = start;
            }
        }
    }

    if (failedStatus !== null) {
        return { name: regionName, status: failedStatus, startTime: failedStart, endTime: failedEnd };
    }
    return {
        name: regionName,
        status: "Succeeded",
        startTime: minStart !== null ? new Date(minStart).toISOString() : null,
        endTime: maxEnd !== null ? new Date(maxEnd).toISOString() : null,
    };
}

// If exactly one region is CheckInProgress and every other is Succeeded, treat
// that lone check as done (ported RolloutService.NormalizeCheckInProgressStatus).
function normalizeCheckInProgress(regions: RegionInfo[]): void {
    let checking: RegionInfo | null = null;
    for (const r of regions) {
        if (r.status === "CheckInProgress") {
            if (checking) return; // more than one -> no-op
            checking = r;
        } else if (r.status !== "Succeeded") {
            return; // some other non-succeeded status -> no-op
        }
    }
    if (checking) checking.status = "Succeeded";
}
