// scripted Anthropic /v1/messages mock: read_page -> write_page -> end_turn
import http from "node:http";

let call = 0;
const responses = [
  {
    content: [
      { type: "tool_use", id: "toolu_mock_1", name: "read_page", input: { slug: "home-server" } },
    ],
    stop_reason: "tool_use",
  },
  {
    content: [
      {
        type: "tool_use",
        id: "toolu_mock_2",
        name: "write_page",
        input: {
          slug: "Tailscale",
          content:
            "---\ntitle: Tailscale\naliases: ts\n---\n\n# Tailscale\n\nTailscale is a mesh VPN built on WireGuard. It is the easiest remote-access path for a [[Home Server]], and pairs well with [[Proxmox]] and [[Self-Hosted Services]].",
        },
      },
    ],
    stop_reason: "tool_use",
  },
  {
    content: [{ type: "text", text: "Created the Tailscale page and linked it from context." }],
    stop_reason: "end_turn",
  },
];

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const scripted = responses[Math.min(call, responses.length - 1)];
      call++;
      console.log(`call ${call}: replying stop_reason=${scripted.stop_reason}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_mock_${call}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: scripted.content,
          stop_reason: scripted.stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      );
    });
  })
  .listen(8788, () => console.log("mock anthropic on :8788"));
