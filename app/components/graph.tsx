import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import type { IndexSource, WikiIndex } from "~/lib/wiki";

// node vocabulary: DESIGN.md → Surfaces → Graph
type GraphNode = SimulationNodeDatum & {
  id: string;
  href: string;
  title: string;
  r: number;
} & ({ kind: "page" } | { kind: "source"; state: IndexSource["state"]; progress: number; favorite: boolean });

type GraphEdge = SimulationLinkDatum<GraphNode> & { dotted: boolean };

const WIDTH = 1000;
const HEIGHT = 700;

function sourceRadius(words: number | undefined) {
  return Math.min(16, Math.max(4, 3 + Math.sqrt(words ?? 0) / 6));
}

export function buildGraph(index: Pick<WikiIndex, "pages" | "sources">) {
  const nodes: GraphNode[] = [
    ...index.pages.map((page) => ({
      kind: "page" as const,
      id: `wiki:${page.slug}`,
      href: `/wiki/${page.slug}`,
      title: page.title,
      r: 7 + Math.min(6, page.cites.length),
    })),
    ...index.sources.map((source) => ({
      kind: "source" as const,
      id: source.matter_id,
      href: `/source/${source.matter_id}`,
      title: source.title,
      r: sourceRadius(source.word_count),
      state: source.state,
      progress: source.progress,
      favorite: source.favorite,
    })),
  ];
  const ids = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const page of index.pages) {
    for (const slug of page.links) {
      if (ids.has(`wiki:${slug}`)) edges.push({ source: `wiki:${page.slug}`, target: `wiki:${slug}`, dotted: false });
    }
    for (const id of page.cites) {
      if (ids.has(id)) edges.push({ source: `wiki:${page.slug}`, target: id, dotted: false });
    }
  }
  for (const source of index.sources) {
    for (const slug of source.near) {
      if (ids.has(`wiki:${slug}`)) edges.push({ source: source.matter_id, target: `wiki:${slug}`, dotted: true });
    }
  }
  return { nodes, edges };
}

// runs the layout to rest once; 100–2000 nodes settle in well under a second
function layout({ nodes, edges }: ReturnType<typeof buildGraph>) {
  const simulation = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-40))
    .force("link", forceLink<GraphNode, GraphEdge>(edges).id((n) => n.id).distance(50))
    .force("collide", forceCollide<GraphNode>((n) => n.r + 3))
    .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
    .stop();
  simulation.tick(300);
  return { nodes, edges };
}

function ProgressRing({ r, progress }: { r: number; progress: number }) {
  const circumference = 2 * Math.PI * r;
  return (
    <>
      <circle r={r} fill="none" className="stroke-border" strokeWidth={3} />
      <circle
        r={r}
        fill="none"
        className="stroke-amber-500"
        strokeWidth={3}
        strokeDasharray={`${circumference * progress} ${circumference}`}
        transform="rotate(-90)"
      />
    </>
  );
}

function NodeShape({ node }: { node: GraphNode }) {
  if (node.kind === "page") {
    const s = node.r * 1.4;
    return <rect x={-s / 2} y={-s / 2} width={s} height={s} transform="rotate(45)" className="fill-sky-700 dark:fill-sky-400" />;
  }
  return (
    <>
      {node.state === "queued" && (
        <circle r={node.r} fill="none" className="stroke-foreground" strokeWidth={1.5} strokeDasharray="3 3" />
      )}
      {node.state === "reading" && <ProgressRing r={node.r} progress={node.progress} />}
      {node.state === "archived" && <circle r={node.r} className="fill-foreground" />}
      {node.favorite && (
        <circle cx={node.r * 0.75} cy={-node.r * 0.75} r={3.5} className="fill-amber-500 stroke-background" strokeWidth={1.5} />
      )}
    </>
  );
}

export function Graph({ index }: { index: Pick<WikiIndex, "pages" | "sources"> }) {
  const graph = useMemo(() => buildGraph(index), [index]);
  // layout runs on the client only; the server renders an empty canvas that hydrates into place
  const [positioned, setPositioned] = useState<ReturnType<typeof layout> | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  useEffect(() => setPositioned(layout(graph)), [graph]);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="aspect-[10/7] w-full rounded border border-border bg-card">
      {positioned?.edges.map((edge, i) => {
        // d3 replaces endpoint ids with node objects once the link force runs
        if (typeof edge.source !== "object" || typeof edge.target !== "object") return null;
        return (
          <line
            key={i}
            x1={edge.source.x}
            y1={edge.source.y}
            x2={edge.target.x}
            y2={edge.target.y}
            className="stroke-muted-foreground/50"
            strokeWidth={1}
            strokeDasharray={edge.dotted ? "2 4" : undefined}
          />
        );
      })}
      {positioned?.nodes.map((node) => (
        <Link key={node.id} to={node.href}>
          <g
            transform={`translate(${node.x},${node.y})`}
            onMouseEnter={() => setHovered(node)}
            onMouseLeave={() => setHovered(null)}
          >
            <title>{node.title}</title>
            <NodeShape node={node} />
          </g>
        </Link>
      ))}
      {hovered && (
        <text
          x={(hovered.x ?? 0) + hovered.r + 6}
          y={(hovered.y ?? 0) + 4}
          className="fill-foreground text-[13px]"
          style={{ pointerEvents: "none" }}
        >
          {hovered.title}
        </text>
      )}
    </svg>
  );
}
