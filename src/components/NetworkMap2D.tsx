import React, { useEffect, useRef, useState } from 'react';
import { ShieldAlert, CheckCircle2, Radio, Globe, Navigation, Layers } from 'lucide-react';
import { WORLD_LAND_PATH } from './worldLand';

interface NetworkMap2DProps {
  isHairpinning: boolean;
  rttMs: number;
  className?: string;
}

interface MapNode {
  id: string;
  name: string;
  country: string;
  lon: number;
  lat: number;
  color: string;
  rttMs?: number;
  type: 'datacenter' | 'ix' | 'international' | 'client';
}

// Projection formula: Equirectangular standard projection mapped to 1000x500 canvas
function project(lon: number, lat: number, width = 1000, height = 500): { x: number; y: number } {
  const x = ((lon + 180) / 360) * width;
  const y = ((90 - lat) / 180) * height;
  return { x, y };
}

export const NetworkMap2D: React.FC<NetworkMap2DProps> = ({
  isHairpinning,
  rttMs,
  className = '',
}) => {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<MapNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const animProgressRef = useRef(0);

  // Exact geographic coordinates of all strategic servers from XCLOUD.md specification
  const nodes: MapNode[] = [
    {
      id: 'sp_azure',
      name: 'Azure brazilsouth (SP)',
      country: 'São Paulo, Brasil',
      lon: -46.63,
      lat: -23.55,
      color: '#00ff66',
      rttMs: 13.5,
      type: 'datacenter',
    },
    {
      id: 'sp_ix',
      name: 'IX.br SP / Equinix Barueri',
      country: 'Barueri SP1-4 (AS8075)',
      lon: -46.87,
      lat: -23.51,
      color: '#00f0ff',
      rttMs: 11.8,
      type: 'ix',
    },
    {
      id: 'rj_ix',
      name: 'IX.br Rio de Janeiro',
      country: 'Rio de Janeiro, Brasil',
      lon: -43.17,
      lat: -22.90,
      color: '#00f0ff',
      rttMs: 19.4,
      type: 'ix',
    },
    {
      id: 'fortaleza',
      name: 'Estação Cabo Submarino (Fortaleza)',
      country: 'Ceará, Brasil (PIX)',
      lon: -38.52,
      lat: -3.73,
      color: '#00f0ff',
      rttMs: 44.2,
      type: 'ix',
    },
    {
      id: 'client_br',
      name: 'Você (Conexão do Usuário)',
      country: 'Sua Rede Local',
      lon: -47.88,
      lat: -18.90,
      color: '#ffffff',
      rttMs: 1.1,
      type: 'client',
    },
    {
      id: 'miami',
      name: 'Equinix Miami (EUA)',
      country: 'Flórida, EUA (AS8075)',
      lon: -80.19,
      lat: 25.76,
      color: '#ffaa00',
      rttMs: 118.5,
      type: 'international',
    },
    {
      id: 'atlanta',
      name: 'CIX-ATL Atlanta (EUA)',
      country: 'Geórgia, EUA (IX-1668)',
      lon: -84.38,
      lat: 33.74,
      color: '#ff003c',
      rttMs: 134.0,
      type: 'international',
    },
    {
      id: 'ashburn',
      name: 'Equinix Ashburn (EUA)',
      country: 'Virgínia, EUA (IX-2572)',
      lon: -77.48,
      lat: 39.04,
      color: '#ff003c',
      rttMs: 142.6,
      type: 'international',
    },
  ];

  // Canvas drawing loop for moving packets along the routes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let lastTime = performance.now();

    const render = (time: number) => {
      const dt = (time - lastTime) / 1000;
      lastTime = time;
      animProgressRef.current = (animProgressRef.current + dt * 0.45) % 1;

      const w = canvas.width;
      const h = canvas.height;

      ctx.clearRect(0, 0, w, h);

      const client = project(nodes[4].lon, nodes[4].lat, w, h);
      const ixSp = project(nodes[1].lon, nodes[1].lat, w, h);
      const azSp = project(nodes[0].lon, nodes[0].lat, w, h);
      const forLanding = project(nodes[3].lon, nodes[3].lat, w, h);
      const miami = project(nodes[5].lon, nodes[5].lat, w, h);
      const atlanta = project(nodes[6].lon, nodes[6].lat, w, h);
      const ashburn = project(nodes[7].lon, nodes[7].lat, w, h);

      // 1. Draw Routes
      // 1A. National Links: Client -> IX.br SP -> Datacenter brazilsouth
      ctx.lineWidth = 3;
      ctx.strokeStyle = isHairpinning ? 'rgba(0, 240, 255, 0.25)' : 'rgba(0, 255, 102, 0.9)';
      ctx.shadowColor = isHairpinning ? 'transparent' : '#00ff66';
      ctx.shadowBlur = isHairpinning ? 0 : 8;

      ctx.beginPath();
      ctx.moveTo(client.x, client.y);
      ctx.lineTo(ixSp.x, ixSp.y);
      ctx.lineTo(azSp.x, azSp.y);
      ctx.stroke();

      // National Coastal Link (SP -> Fortaleza)
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.45)';
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(ixSp.x, ixSp.y);
      ctx.lineTo(forLanding.x, forLanding.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // 1B. International Transatlantic Submarine Cable (Brazil/Fortaleza -> Equinix Miami)
      const isSubmarineAlert = isHairpinning;
      ctx.lineWidth = isSubmarineAlert ? 3.5 : 2;
      ctx.strokeStyle = isSubmarineAlert ? '#ff003c' : 'rgba(255, 170, 0, 0.85)';
      ctx.shadowColor = isSubmarineAlert ? '#ff003c' : '#ffaa00';
      ctx.shadowBlur = isSubmarineAlert ? 10 : 4;

      // Submarine cable arc through the Atlantic
      const midAtlanticX = (forLanding.x + miami.x) / 2 + 35;
      const midAtlanticY = (forLanding.y + miami.y) / 2 - 15;

      ctx.beginPath();
      ctx.moveTo(forLanding.x, forLanding.y);
      ctx.quadraticCurveTo(midAtlanticX, midAtlanticY, miami.x, miami.y);
      ctx.stroke();

      // 1C. US Interconnect (Miami -> Atlanta -> Ashburn)
      ctx.lineWidth = isSubmarineAlert ? 3 : 1.8;
      ctx.strokeStyle = isSubmarineAlert ? '#ff3b30' : 'rgba(255, 80, 80, 0.7)';
      ctx.beginPath();
      ctx.moveTo(miami.x, miami.y);
      ctx.lineTo(atlanta.x, atlanta.y);
      ctx.lineTo(ashburn.x, ashburn.y);
      ctx.stroke();

      // 1D. If Hairpinning, draw detour return path back to SP!
      if (isHairpinning) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255, 0, 60, 0.85)';
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(atlanta.x, atlanta.y);
        ctx.quadraticCurveTo(w * 0.32, h * 0.45, azSp.x, azSp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.shadowBlur = 0;

      // 2. Animated Traveling Packets
      const progress = animProgressRef.current;

      // 2A. National Packets (Client -> SP -> Azure)
      if (!isHairpinning) {
        const p1 = (progress * 2) % 1;
        const x1 = client.x + (azSp.x - client.x) * p1;
        const y1 = client.y + (azSp.y - client.y) * p1;

        ctx.fillStyle = '#00ff66';
        ctx.shadowColor = '#00ff66';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(x1, y1, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // 2B. International Submarine Cable Packets (Fortaleza -> Miami)
      const t = progress;
      const p0x = forLanding.x;
      const p0y = forLanding.y;
      const p1x = midAtlanticX;
      const p1y = midAtlanticY;
      const p2x = miami.x;
      const p2y = miami.y;

      const subX = (1 - t) * (1 - t) * p0x + 2 * (1 - t) * t * p1x + t * t * p2x;
      const subY = (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * p1y + t * t * p2y;

      ctx.fillStyle = isHairpinning ? '#ff003c' : '#ffaa00';
      ctx.shadowColor = isHairpinning ? '#ff003c' : '#ffaa00';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(subX, subY, isHairpinning ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();

      // US Link Packet (Miami -> Atlanta)
      const p3 = (progress + 0.5) % 1;
      const usX = miami.x + (atlanta.x - miami.x) * p3;
      const usY = miami.y + (atlanta.y - miami.y) * p3;
      ctx.beginPath();
      ctx.arc(usX, usY, isHairpinning ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowBlur = 0;

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isHairpinning]);

  return (
    <div className={`relative rounded-xl border border-cyan-900/40 bg-[#02070d] overflow-hidden ${className}`}>
      {/* Top Map Bar */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-2 pointer-events-none">
        <div className="px-2.5 py-1 bg-[#040e17]/95 border border-cyan-500/30 rounded text-xs font-mono text-cyan-300 flex items-center gap-2 shadow-lg">
          <Globe className="w-3.5 h-3.5 text-cyan-400" />
          <span>MAPA MUNDI TÁTICO // CABOS SUBMARINOS AS8075</span>
        </div>

        {isHairpinning ? (
          <div className="px-2.5 py-1 bg-red-950/90 border border-red-500/60 rounded text-xs font-mono text-red-300 flex items-center gap-1.5 shadow-lg">
            <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
            <span>DESVIO BGP ATIVO (EUA)</span>
          </div>
        ) : (
          <div className="px-2.5 py-1 bg-emerald-950/90 border border-emerald-500/50 rounded text-xs font-mono text-emerald-300 flex items-center gap-1.5 shadow-lg">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>ROTA DIRETA NACIONAL (SP)</span>
          </div>
        )}
      </div>

      {/* Geographically Exact Vector World Map (Full Contours & Real Equirectangular Geometry) */}
      <div
        onClick={() => setSelectedNode(null)}
        className="relative w-full h-[440px] sm:h-[480px] bg-[#020912] overflow-hidden select-none cursor-default"
      >
        {/* Subtle Equirectangular Grid Lines (15° increments) */}
        <svg className="absolute inset-0 w-full h-full opacity-20 pointer-events-none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="latlonGrid" width="41.66" height="41.66" patternUnits="userSpaceOnUse">
              <path d="M 41.66 0 L 0 0 0 41.66" fill="none" stroke="#00f0ff" strokeWidth="0.4" strokeDasharray="2 4" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#latlonGrid)" />
          {/* Equator & Prime Meridian Indicator */}
          <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#00f0ff" strokeWidth="0.8" opacity="0.4" />
          <line x1="50%" y1="0" x2="50%" y2="100%" stroke="#00f0ff" strokeWidth="0.8" opacity="0.4" />
        </svg>

        {/* World map outlines (Natural Earth) */}
        <svg
          viewBox="0 0 1000 500"
          className="absolute inset-0 w-full h-full pointer-events-none"
          preserveAspectRatio="none"
        >
          {/* DEFINITIONS FOR GLOW FILTERS */}
          <defs>
            <filter id="landGlow" x="-10%" y="-10%" width="120%" height="120%">
              <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor="#00f0ff" floodOpacity="0.25" />
            </filter>
          </defs>

          {/* Land: Natural Earth 1:50m outlines, same projection as the pins */}
          <g filter="url(#landGlow)">
            <path d={WORLD_LAND_PATH} fill="#061826" fillRule="evenodd" stroke="#0c344a" strokeWidth="0.7" strokeLinejoin="round" />
          </g>

          {/* Tactical Typography & Ocean Watermarks */}
          <text x="320" y="155" fill="#0b3144" fontSize="11" fontFamily="monospace" letterSpacing="4">
            ATLÂNTICO NORTE
          </text>
          <text x="420" y="380" fill="#0b3144" fontSize="11" fontFamily="monospace" letterSpacing="4">
            ATLÂNTICO SUL
          </text>
          <text x="120" y="240" fill="#082332" fontSize="12" fontFamily="monospace" letterSpacing="5">
            OCEANO PACÍFICO
          </text>
          <text x="328" y="285" fill="#14526d" fontSize="14" fontWeight="bold" fontFamily="monospace" letterSpacing="2">
            BRASIL (AS8075)
          </text>
          <text x="195" y="135" fill="#104257" fontSize="13" fontWeight="bold" fontFamily="monospace" letterSpacing="2">
            ESTADOS UNIDOS
          </text>

          {/* Submarine Cable Descriptor */}
          <text
            x="320"
            y="218"
            fill={isHairpinning ? '#ff4d4d' : '#ffaa00'}
            fontSize="10"
            fontFamily="monospace"
            fontWeight="bold"
          >
            Cabo Submarino Transatlântico (Monet / Seabras-1)
          </text>
        </svg>

        {/* Dynamic HTML5 Canvas for laser packet pulses along the routes */}
        <canvas
          ref={canvasRef}
          width={1000}
          height={500}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        {/* Server & Peering Node Pins positioned by exact geographic lon/lat */}
        {nodes.map((node) => {
          const coords = project(node.lon, node.lat, 100, 100);
          const isSelected = selectedNode?.id === node.id;
          const isHovered = hoveredNodeId === node.id;
          const isUsDetour = isHairpinning && node.type === 'international';
          const isVisible = isSelected || isHovered;

          return (
            <div
              key={node.id}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedNode((prev) => (prev?.id === node.id ? null : node));
              }}
              onMouseEnter={() => setHoveredNodeId(node.id)}
              onMouseLeave={() => setHoveredNodeId(null)}
              style={{ left: `${coords.x}%`, top: `${coords.y}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 z-10 cursor-pointer group pointer-events-auto"
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center transition-transform group-hover:scale-125"
                style={{
                  backgroundColor: `${node.color}25`,
                  border: `1.5px solid ${node.color}`,
                  boxShadow: `0 0 10px ${node.color}80`,
                }}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: node.color }}
                />
              </div>

              {/* Node Label Tooltip - Appears strictly on hover or click */}
              <div
                className={`absolute left-3.5 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded whitespace-nowrap text-[10px] font-mono font-bold border shadow-lg transition-all duration-150 ${
                  isVisible
                    ? 'opacity-100 scale-100 z-30 pointer-events-auto'
                    : 'opacity-0 scale-95 z-0 pointer-events-none'
                } ${
                  isUsDetour
                    ? 'bg-red-950 text-red-200 border-red-500 ring-1 ring-red-500'
                    : isSelected
                    ? 'bg-cyan-950 text-cyan-200 border-cyan-400 ring-1 ring-cyan-400/50'
                    : 'bg-[#030910]/95 text-slate-300 border-slate-700/70'
                }`}
              >
                <span>{node.name}</span>
                {node.rttMs && (
                  <span className="ml-1 text-[9px] text-slate-400">
                    ({node.rttMs.toFixed(1)}ms)
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Map Footer & Route Explanation Legend */}
      <div className="p-3 bg-[#030a12] border-t border-cyan-900/40 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs font-mono">
        <div className="flex flex-wrap items-center gap-4 text-slate-300">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-1 rounded bg-[#00ff66]"></span>
            <span>Rota Nacional Direta (IX.br SP / PNI 100G)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-1 rounded bg-[#ffaa00]"></span>
            <span>Cabo Submarino Transatlântico (Fortaleza → Miami)</span>
          </div>
          {isHairpinning && (
            <div className="flex items-center gap-1.5 text-red-400 font-bold">
              <span className="w-3 h-1 rounded bg-[#ff003c]"></span>
              <span>Desvio Ativo (BGP Hairpinning: ~138ms)</span>
            </div>
          )}
        </div>

        <div className="text-slate-400 text-[11px]">
          Passe o mouse ou clique nos nós para inspecionar telemetria e detalhes
        </div>
      </div>

      {/* Node Details Drawer when clicked */}
      {selectedNode && (
        <div className="p-2.5 bg-cyan-950/50 border-t border-cyan-500/40 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-3">
            <Radio className="w-4 h-4 text-cyan-400" />
            <span className="text-slate-200 font-bold">{selectedNode.name}</span>
            <span className="text-slate-400">| {selectedNode.country}</span>
            {selectedNode.rttMs && (
              <span className="text-emerald-400 font-bold">
                Latência de Sondagem: {selectedNode.rttMs.toFixed(1)} ms
              </span>
            )}
          </div>
          <button
            onClick={() => setSelectedNode(null)}
            className="text-slate-400 hover:text-slate-200 text-xs px-2 py-0.5 rounded bg-black/40"
          >
            Fechar
          </button>
        </div>
      )}
    </div>
  );
};
