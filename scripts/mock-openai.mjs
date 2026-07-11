// scripted OpenAI /responses mock: read_page -> write_page -> final report
import http from "node:http";

let call = 0;
const responses = [
  {
    output: [
      {
        type: "function_call",
        id: "fc_mock_1",
        call_id: "call_mock_1",
        name: "read_page",
        arguments: JSON.stringify({ slug: "home-server" }),
        status: "completed",
      },
    ],
  },
  {
    output: [
      {
        type: "function_call",
        id: "fc_mock_2",
        call_id: "call_mock_2",
        name: "write_page",
        arguments: JSON.stringify({
          slug: "Tailscale",
          content:
            "---\ntitle: Tailscale\naliases: ts\n---\n\n# Tailscale\n\nTailscale is a mesh VPN built on WireGuard. It is the easiest remote-access path for a [[Home Server]], and pairs well with [[Proxmox]] and [[Self-Hosted Services]].",
        }),
        status: "completed",
      },
    ],
  },
  {
    output: [
      {
        type: "message",
        id: "msg_mock_3",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: "Created the Tailscale page and linked it from context.",
            annotations: [],
          },
        ],
      },
    ],
  },
];

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body);
      const invalidRequest =
        req.url !== "/responses" ||
        Boolean(req.headers.authorization) ||
        req.headers["cf-aig-authorization"] !== "Bearer mock-token-local-test" ||
        req.headers["cf-aig-skip-cache"] !== "true" ||
        req.headers["cf-aig-collect-log-payload"] !== "false" ||
        request.model !== "gpt-5.6-sol" ||
        request.reasoning?.effort !== "high" ||
        request.store !== false;
      if (invalidRequest) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unexpected mock request" } }));
        return;
      }

      const scripted = responses[Math.min(call, responses.length - 1)];
      call++;
      const outputText = scripted.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .filter((item) => item.type === "output_text")
        .map((item) => item.text)
        .join("\n");
      console.log(`call ${call}: replying output=${scripted.output[0].type}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `resp_mock_${call}`,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: "gpt-5.6-sol",
          output: scripted.output,
          output_text: outputText,
        }),
      );
    });
  })
  .listen(8788, () => console.log("mock OpenAI responses API on :8788"));
