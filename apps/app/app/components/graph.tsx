import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import type { IndexSource, Link as WikiLink } from "~/lib/wiki";

// node vocabulary: DESIGN.md → Surfaces → Graph
type GraphNode = SimulationNodeDatum & {
  id: string;
  title: string;
  r: number;
  state: IndexSource["state"];
  progress: number;
};

type GraphEdge = SimulationLinkDatum<GraphNode> & { label: string };

const WIDTH = 1000;
const HEIGHT = 700;
const PAD = 12;

function sourceRadius(words: number | undefined) {
  return Math.min(16, Math.max(4, 3 + Math.sqrt(words ?? 0) / 6));
}

export function buildGraph({ sources, links }: { sources: IndexSource[]; links: WikiLink[] }) {
  const nodes: GraphNode[] = sources.map((source) => ({
    id: source.matter_id,
    title: source.title,
    r: sourceRadius(source.word_count),
    state: source.state,
    progress: source.progress,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  // links are filtered to the visible nodes; the index already holds one entry per pair
  const edges: GraphEdge[] = links
    .filter(({ a, b }) => ids.has(a) && ids.has(b))
    .map(({ a, b, label }) => ({ source: a, target: b, label }));
  return { nodes, edges };
}

// runs the layout to rest once; 100–2000 nodes settle in well under a second
function layout({ nodes, edges }: ReturnType<typeof buildGraph>) {
  const simulation = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-40))
    .force("link", forceLink<GraphNode, GraphEdge>(edges).id((n) => n.id).distance(50))
    .force("collide", forceCollide<GraphNode>((n) => n.r + 3))
    .force("center", forceCenter(WIDTH / 2, HEIGHT / 2))
    // weak pull inward so a sparse library stays a cloud instead of drifting off-canvas
    .force("x", forceX(WIDTH / 2).strength(0.025))
    .force("y", forceY(HEIGHT / 2).strength(0.04))
    .stop();
  simulation.tick(300);
  for (const node of nodes) {
    node.x = Math.min(WIDTH - PAD - node.r, Math.max(PAD + node.r, node.x ?? 0));
    node.y = Math.min(HEIGHT - PAD - node.r, Math.max(PAD + node.r, node.y ?? 0));
  }
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

// centered at the svg origin; callers position with a transform or a centered viewBox
export function SourceGlyph({ r, state, progress }: { r: number; state: IndexSource["state"]; progress: number }) {
  return (
    <>
      {/* hollow states are clickable across the whole disc, not only on the rim */}
      <circle r={r} fill="transparent" />
      {state === "queued" && (
        <circle r={r} fill="none" className="stroke-foreground" strokeWidth={1.5} strokeDasharray="3 3" />
      )}
      {state === "reading" && <ProgressRing r={r} progress={progress} />}
      {state === "archived" && <circle r={r} className="fill-foreground" />}
    </>
  );
}

const LEGEND = [
  { label: "queued", glyph: <SourceGlyph r={6} state="queued" progress={0} /> },
  { label: "reading", glyph: <SourceGlyph r={6} state="reading" progress={0.4} /> },
  { label: "archived", glyph: <SourceGlyph r={6} state="archived" progress={0} /> },
  {
    label: "related (hover for why)",
    glyph: <line x1={-9} x2={9} className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="2 3" />,
  },
];

function endpoints(edge: GraphEdge) {
  // d3 replaces endpoint ids with node objects once the link force runs
  return typeof edge.source === "object" && typeof edge.target === "object"
    ? { a: edge.source, b: edge.target }
    : null;
}

export function Graph({ sources, links }: { sources: IndexSource[]; links: WikiLink[] }) {
  const graph = useMemo(() => buildGraph({ sources, links }), [sources, links]);
  // layout runs on the client only; the server renders an empty canvas that hydrates into place
  const [positioned, setPositioned] = useState<ReturnType<typeof layout> | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<GraphEdge | null>(null);
  useEffect(() => setPositioned(layout(graph)), [graph]);

  const labelOnLeft = Boolean(hovered && (hovered.x ?? 0) > WIDTH * 0.7);
  const edgeLabel = hoveredEdge && endpoints(hoveredEdge);

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="aspect-[10/7] w-full rounded border border-border bg-card">
        {positioned?.edges.map((edge, i) => {
          const ends = endpoints(edge);
          if (!ends) return null;
          const active = edge === hoveredEdge || (hovered !== null && (ends.a === hovered || ends.b === hovered));
          return (
            // a wide transparent stroke makes the thin line hoverable
            <g key={i} onMouseEnter={() => setHoveredEdge(edge)} onMouseLeave={() => setHoveredEdge(null)}>
              <line x1={ends.a.x} y1={ends.a.y} x2={ends.b.x} y2={ends.b.y} stroke="transparent" strokeWidth={12} />
              <line
                x1={ends.a.x}
                y1={ends.a.y}
                x2={ends.b.x}
                y2={ends.b.y}
                className={active ? "stroke-foreground" : "stroke-muted-foreground/50"}
                strokeWidth={active ? 1.5 : 1}
                strokeDasharray="2 4"
              />
            </g>
          );
        })}
        {positioned?.nodes.map((node) => (
          <Link key={node.id} to={`/source/${node.id}`}>
            <g
              transform={`translate(${node.x},${node.y})`}
              className="cursor-pointer"
              onMouseEnter={() => setHovered(node)}
              onMouseLeave={() => setHovered(null)}
            >
              <title>{node.title}</title>
              {hovered === node && <circle r={node.r + 5} fill="none" className="stroke-foreground/25" strokeWidth={2} />}
              <SourceGlyph r={node.r} state={node.state} progress={node.progress} />
            </g>
          </Link>
        ))}
        {edgeLabel && !hovered && (
          <text
            x={((edgeLabel.a.x ?? 0) + (edgeLabel.b.x ?? 0)) / 2}
            y={((edgeLabel.a.y ?? 0) + (edgeLabel.b.y ?? 0)) / 2 - 6}
            textAnchor="middle"
            paintOrder="stroke"
            strokeWidth={4}
            strokeLinejoin="round"
            className="fill-foreground stroke-card text-[13px]"
            style={{ pointerEvents: "none" }}
          >
            {hoveredEdge?.label}
          </text>
        )}
        {hovered && (
          <text
            x={(hovered.x ?? 0) + (labelOnLeft ? -1 : 1) * (hovered.r + 10)}
            y={(hovered.y ?? 0) + 4}
            textAnchor={labelOnLeft ? "end" : "start"}
            paintOrder="stroke"
            strokeWidth={4}
            strokeLinejoin="round"
            className="fill-foreground stroke-card text-[13px] font-medium"
            style={{ pointerEvents: "none" }}
          >
            {hovered.title}
          </text>
        )}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {LEGEND.map(({ label, glyph }) => (
          <li key={label} className="flex items-center gap-1.5">
            <svg width={20} height={20} viewBox="-10 -10 20 20" aria-hidden>
              {glyph}
            </svg>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
