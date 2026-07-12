import { useState } from "react";
import { useMatches, useRevalidator } from "react-router";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import type { SynthesisResult } from "../../workers/synthesis";
import type { JobStatus } from "~/routes/api.jobs";

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function pollJob(id: string): Promise<SynthesisResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) throw new Error("job status unavailable");
    const job = await res.json<JobStatus>();
    if (job.state === "done") return job.result;
    if (job.state === "failed") throw new Error("synthesis failed");
  }
  throw new Error("synthesis timed out");
}

export function InputBox() {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const matches = useMatches();
  const revalidator = useRevalidator();

  async function submit() {
    const input = text.trim();
    if (!input || pending) return;
    setPending(true);
    setText("");

    const contextSlug = matches.find((m) => m.params.slug)?.params.slug;

    try {
      const res = await fetch("/api/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input, contextSlug }),
      });
      if (!res.ok) throw new Error("failed to submit");
      const { id } = await res.json<{ id: string }>();
      toast("Synthesizing…", { id });

      const result = await pollJob(id);
      toast.success("Synthesized", {
        id,
        description: (
          <span>
            {result.written.length === 0
              ? result.report.slice(0, 200)
              : result.written.map((slug, i) => (
                  <span key={slug}>
                    {i > 0 && " · "}
                    <a href={`/wiki/${slug}`} className="underline">
                      {slug}
                    </a>
                  </span>
                ))}
          </span>
        ),
        duration: 15000,
      });
      revalidator.revalidate();
    } catch (error) {
      setText(input);
      toast.error(error instanceof Error ? error.message : "something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border bg-card p-2 shadow-lg">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder="Drop a thought, link, or instruction…"
        className="min-h-16 resize-none border-0 shadow-none focus-visible:ring-0"
      />
      <div className="mt-1 flex justify-end">
        <Button size="sm" onClick={submit} disabled={pending || !text.trim()}>
          {pending ? "Synthesizing…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
