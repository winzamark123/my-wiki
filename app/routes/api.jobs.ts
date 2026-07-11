import { env } from "cloudflare:workers";
import { data } from "react-router";

import type { Route } from "./+types/api.jobs";
import type { SynthesisResult } from "../../workers/synthesis";

// maps Workflow statuses to an app-owned contract so the UI doesn't depend on the job mechanism
export async function loader({ params }: Route.LoaderArgs) {
  try {
    const instance = await env.SYNTHESIS_WORKFLOW.get(params.id);
    const { status, output } = await instance.status();
    if (status === "complete") {
      return { state: "done" as const, result: output as SynthesisResult };
    }
    if (status === "errored" || status === "terminated") {
      return { state: "failed" as const };
    }
    return { state: "running" as const };
  } catch {
    return data({ error: "unknown job" }, { status: 404 });
  }
}
