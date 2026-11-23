import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { MessageSquare, Send, Sparkles, User, Bot, Wifi, Server, Activity, AlertTriangle, Loader2, Settings } from 'lucide-react';
import { fetchAiStatus, sendAiChat, AiChatResponse } from '../services/nativeBridge';
import { GamingVerdict, NetworkMetrics, StrategicEndpoint, TracerouteReport } from '../types/telemetry';

interface RobotMascotProps {
  verdict: GamingVerdict;
  metrics: NetworkMetrics;
  isHairpinning: boolean;
  endpoints?: StrategicEndpoint[];
  traceroute?: TracerouteReport;
  onOpenSettings?: () => void;
  refreshTrigger?: number;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  timestamp: string;
  highlight?: string;
  isLocalOnly?: boolean;
}

export const RobotMascot: React.FC<RobotMascotProps> = ({
  verdict,
  metrics,
  isHairpinning,
  endpoints = [],
  traceroute,
  onOpenSettings,
  refreshTrigger = 0,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState<{
    enabled: boolean;
    provider: string;
    model: string;
    message: string;
    checked: boolean;
  }>({
    enabled: false,
    provider: 'OpenAI',
    model: 'gpt-4o-mini',
    message: '',
    checked: false,
  });

  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Initial chat message history
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      sender: 'bot',
      text: `Olá! Sou seu assistente de telemetria xCloud. No momento sua conexão está classificada como Rank ${verdict.rank} (${metrics.rttMs.toFixed(1)}ms RTT). Clique nas perguntas rápidas ou envie uma mensagem para saber se os servidores estão lotados ou se há problemas de rota!`,
      timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  // References for 3D Robot Head
  const mousePosRef = useRef({ x: 0, y: 0 });
  const robotHeadRef = useRef<THREE.Group | null>(null);
  const visorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const visorTextureRef = useRef<THREE.CanvasTexture | null>(null);
  const blinkStateRef = useRef({ isBlinking: false, nextBlink: Date.now() + 2500 });

  // 1. Initialize Clean 3D Robot Head (Borderless, seamless integration)
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 150;
    const height = container.clientHeight || 150;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 50);
    camera.position.set(0, 0, 4.8);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true, // Transparent canvas, zero box border!
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Studio lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.4);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0x00f0ff, 2.8);
    keyLight.position.set(3, 4, 4);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x00ff66, 2.2);
    rimLight.position.set(-3, -2, -2);
    scene.add(rimLight);

    // Master Group
    const robotGroup = new THREE.Group();
    robotHeadRef.current = robotGroup;
    scene.add(robotGroup);

    // Helmet Chassis (Curved aerodynamic robot head)
    const helmetGeo = new THREE.SphereGeometry(0.95, 36, 32);
    helmetGeo.scale(1.12, 1.0, 0.94);
    const helmetMat = new THREE.MeshStandardMaterial({
      color: 0x0a1622,
      metalness: 0.7,
      roughness: 0.25,
      emissive: new THREE.Color(0x030d17),
      emissiveIntensity: 0.5,
    });
    const helmetMesh = new THREE.Mesh(helmetGeo, helmetMat);
    robotGroup.add(helmetMesh);

    // Halo Head Ring (Glowing Xbox Green / Cyan Top Trim)
    const haloGeo = new THREE.TorusGeometry(0.82, 0.04, 16, 48);
    haloGeo.rotateX(Math.PI / 2);
    haloGeo.scale(1.1, 0.9, 1);
    const haloMat = new THREE.MeshStandardMaterial({
      color: isHairpinning ? 0xff003c : 0x00ff66,
      emissive: new THREE.Color(isHairpinning ? 0xff003c : 0x00ff66),
      emissiveIntensity: 0.95,
      roughness: 0.1,
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    haloMesh.position.set(0, 0.52, 0);
    robotGroup.add(haloMesh);

    // Face Visor Screen (Where OLED eyes are rendered)
    const visorGeo = new THREE.SphereGeometry(0.9, 32, 24, 0, Math.PI);
    visorGeo.rotateY(Math.PI / 2);
    visorGeo.scale(0.92, 0.72, 0.65);
    visorGeo.translate(0, 0.02, 0.42);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    visorCanvasRef.current = canvas;
    const visorTexture = new THREE.CanvasTexture(canvas);
    visorTexture.colorSpace = THREE.SRGBColorSpace;
    visorTextureRef.current = visorTexture;

    const visorMat = new THREE.MeshBasicMaterial({
      map: visorTexture,
      transparent: true,
      opacity: 0.96,
    });
    const visorMesh = new THREE.Mesh(visorGeo, visorMat);
    robotGroup.add(visorMesh);

    // Cute Side Cyber Ears
    const earGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.2, 24);
    earGeo.rotateZ(Math.PI / 2);
    const earMat = new THREE.MeshStandardMaterial({
      color: 0x112837,
      metalness: 0.8,
      roughness: 0.2,
    });

    const leftEar = new THREE.Mesh(earGeo, earMat);
    leftEar.position.set(-1.14, 0, 0);
    robotGroup.add(leftEar);

    const rightEar = new THREE.Mesh(earGeo, earMat);
    rightEar.position.set(1.14, 0, 0);
    robotGroup.add(rightEar);

    // Glowing tip spheres
    const tipGeo = new THREE.SphereGeometry(0.075, 16, 16);
    const tipMat = new THREE.MeshBasicMaterial({
      color: isHairpinning ? 0xff3b30 : 0x00f0ff,
    });
    const leftTip = new THREE.Mesh(tipGeo, tipMat);
    leftTip.position.set(-1.26, 0, 0);
    robotGroup.add(leftTip);

    const rightTip = new THREE.Mesh(tipGeo, tipMat);
    rightTip.position.set(1.26, 0, 0);
    robotGroup.add(rightTip);

    // Mouse Tracking Event (Head tracks the user's cursor across screen)
    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const nx = (e.clientX - centerX) / (window.innerWidth / 2);
      const ny = (e.clientY - centerY) / (window.innerHeight / 2);

      mousePosRef.current = {
        x: Math.max(-1, Math.min(1, nx)),
        y: Math.max(-1, Math.min(1, ny)),
      };
    };

    window.addEventListener('mousemove', handleMouseMove);

    // Render loop
    let animId = 0;
    let clock = new THREE.Clock();

    const drawVisorFace = (time: number) => {
      const cvs = visorCanvasRef.current;
      if (!cvs) return;
      const ctx = cvs.getContext('2d')!;

      ctx.clearRect(0, 0, cvs.width, cvs.height);

      ctx.fillStyle = '#01050a';
      ctx.fillRect(0, 0, cvs.width, cvs.height);

      // Subtle horizontal scanline grid
      ctx.fillStyle = 'rgba(0, 240, 255, 0.04)';
      for (let y = 0; y < cvs.height; y += 4) {
        ctx.fillRect(0, y, cvs.width, 1);
      }

      // Check blink state
      const now = Date.now();
      if (now > blinkStateRef.current.nextBlink) {
        blinkStateRef.current.isBlinking = true;
        if (now > blinkStateRef.current.nextBlink + 180) {
          blinkStateRef.current.isBlinking = false;
          blinkStateRef.current.nextBlink = now + 2400 + Math.random() * 2600;
        }
      }

      const isBlinking = blinkStateRef.current.isBlinking;
      const eyeColor = isHairpinning ? '#ff3b30' : verdict.rank === 'S' ? '#00ff66' : '#00f0ff';
      const eyeGlow = isHairpinning ? 'rgba(255, 59, 48, 0.6)' : 'rgba(0, 240, 255, 0.6)';

      ctx.shadowColor = eyeGlow;
      ctx.shadowBlur = 16;
      ctx.fillStyle = eyeColor;
      ctx.strokeStyle = eyeColor;
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';

      const eyeOffsetX = mousePosRef.current.x * 24;
      const eyeOffsetY = mousePosRef.current.y * 16;

      const leftEyeX = 180 + eyeOffsetX;
      const rightEyeX = 332 + eyeOffsetX;
      const eyeY = 118 + eyeOffsetY;

      if (isBlinking) {
        ctx.beginPath();
        ctx.moveTo(leftEyeX - 26, eyeY);
        ctx.lineTo(leftEyeX + 26, eyeY);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(rightEyeX - 26, eyeY);
        ctx.lineTo(rightEyeX + 26, eyeY);
        ctx.stroke();
      } else if (isHairpinning) {
        // Worried slanted alert eyes
        ctx.beginPath();
        ctx.moveTo(leftEyeX - 24, eyeY - 14);
        ctx.lineTo(leftEyeX + 22, eyeY + 12);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(rightEyeX + 24, eyeY - 14);
        ctx.lineTo(rightEyeX - 22, eyeY + 12);
        ctx.stroke();
      } else if (verdict.rank === 'S') {
        // Happy arched eyes (^ ^)
        ctx.beginPath();
        ctx.arc(leftEyeX, eyeY + 14, 26, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(rightEyeX, eyeY + 14, 26, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      } else {
        // Friendly round OLED eyes
        ctx.beginPath();
        ctx.ellipse(leftEyeX, eyeY, 24, 30, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.ellipse(rightEyeX, eyeY, 24, 30, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(leftEyeX - 8, eyeY - 8, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(rightEyeX - 8, eyeY - 8, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (visorTextureRef.current) {
        visorTextureRef.current.needsUpdate = true;
      }
    };

    const tick = () => {
      const delta = clock.getDelta();
      const time = clock.getElapsedTime();

      // Smooth floating bob
      if (robotGroup) {
        robotGroup.position.y = Math.sin(time * 2.5) * 0.08;

        const targetRotY = mousePosRef.current.x * 0.45;
        const targetRotX = -mousePosRef.current.y * 0.35;

        robotGroup.rotation.y += (targetRotY - robotGroup.rotation.y) * 0.08;
        robotGroup.rotation.x += (targetRotX - robotGroup.rotation.x) * 0.08;
      }

      drawVisorFace(time);

      renderer.render(scene, camera);
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      helmetGeo.dispose();
      helmetMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      visorGeo.dispose();
      visorMat.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [isHairpinning, verdict.rank]);

  // Auto-scroll chat to latest message (scrolls strictly inside the chat container to keep page scroll at the top)
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, isAiLoading]);

  // Check OpenAI AI status
  useEffect(() => {
    let isMounted = true;
    fetchAiStatus()
      .then((data) => {
        if (isMounted) {
          setAiStatus({
            enabled: Boolean(data.enabled),
            provider: data.provider || 'OpenAI',
            model: data.model || 'gpt-4o-mini',
            message: data.message || '',
            checked: true,
          });
        }
      })
      .catch(() => {
        if (isMounted) {
          setAiStatus((prev) => ({ ...prev, enabled: false, checked: true }));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [refreshTrigger]);

  const handleSendPrompt = async (questionText: string, category?: 'verdict' | 'servers' | 'route' | 'tips') => {
    if (isAiLoading) return;
    const nowTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    // 1. Add User Message
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: questionText,
      timestamp: nowTime,
    };

    setMessages((prev) => [...prev, userMsg]);

    // 2. If OpenAI is configured and enabled, query the OpenAI backend endpoint
    if (aiStatus.enabled) {
      setIsAiLoading(true);

      try {
        let data: AiChatResponse | null = null;
        let lastErr: any = null;

        // Quick 1-retry in case the dev server reloaded
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
          try {
            data = await sendAiChat({
              message: questionText,
              context: {
                metrics,
                verdict,
                isHairpinning,
                endpoints,
                traceroute,
              },
              history: messages.slice(-4),
            });
          } catch (err) {
            lastErr = err;
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 600));
            }
          }
        }

        if (!data) {
          throw lastErr || new Error('Falha de conexão com o backend de IA.');
        }

        const botReplyText =
          data.reply ||
          (data.error ? `Aviso da OpenAI: ${data.error}` : 'Diagnóstico de telemetria concluído.');

        if (data.enabled === false) {
          setAiStatus((prev) => ({
            ...prev,
            enabled: false,
            message: data.reply || 'IA desabilitada',
          }));
        }

        const botMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          sender: 'bot',
          text: botReplyText,
          timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          isLocalOnly: !data.enabled,
        };

        setMessages((prev) => [...prev, botMsg]);
      } catch (err: any) {
        console.error('Erro ao consultar a OpenAI:', err);
        const errorDetail = err?.message ? ` (${err.message})` : '';
        const fallbackReply = `Instabilidade ao consultar a IA${errorDetail}. Diagnóstico local: ${verdict.headline} com ${metrics.rttMs.toFixed(1)}ms de RTT.`;
        const botMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          sender: 'bot',
          text: fallbackReply,
          timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          isLocalOnly: true,
        };
        setMessages((prev) => [...prev, botMsg]);
      } finally {
        setIsAiLoading(false);
      }
      return;
    }

    // 3. Fallback when AI is disabled (API Key not in .env): Provide deterministic local telemetry diagnostics
    let botReplyText = '';
    const currentRtt = metrics.smoothedRttMs ?? metrics.rttMs;
    if (category === 'verdict') {
      botReplyText = `[Diagnóstico Local] ${verdict.headline}. ${verdict.statusText}`;
      if (metrics.resilience) {
        botReplyText += ` Análise resiliente (N=10): tendência ${metrics.resilience.trend.toLowerCase()} com ${metrics.resilience.stabilityScore}% de consistência.`;
      }
    } else if (category === 'servers') {
      if (currentRtt >= 45.0) {
        botReplyText = `[Diagnóstico de Isolamento] Atenção: sua latência de rede está alta (${currentRtt.toFixed(1)}ms). O gargalo está na conexão de internet, gerando atraso e input lag nos comandos! O momento não é bom para jogar.`;
      } else {
        botReplyText = `[Diagnóstico Local] Isolamento: ${verdict.rootCauseTitle}. ${verdict.rootCauseDescription}`;
      }
    } else if (category === 'route') {
      if (isHairpinning) {
        botReplyText = `[Diagnóstico Local] ALERTA DE ROTA: Sua conexão está sofrendo de BGP Hairpinning! Seus pacotes estão sendo exportados para os Estados Unidos antes de voltar para São Paulo. O problema é na rota da sua operadora (ISP).`;
      } else if (currentRtt >= 65.0) {
        botReplyText = `[Diagnóstico de Rota] Sua rota até São Paulo está com latência crítica de ${currentRtt.toFixed(1)}ms (${metrics.ttlHops} saltos). Embora não haja desvio internacional para os EUA, o atraso é elevado demais para jogos em tempo real.`;
      } else if (currentRtt >= 45.0) {
        botReplyText = `[Diagnóstico de Rota] Rota nacional com latência elevada (${currentRtt.toFixed(1)}ms em ${metrics.ttlHops} saltos). Não há desvio BGP para os EUA, mas você sentirá atraso de comandos em jogos de ação.`;
      } else {
        botReplyText = `[Diagnóstico Local] Sua rota até São Paulo está excelente! Tráfego entregue diretamente no IX.br São Paulo (AS8075) com latência ultrabaixa de ${currentRtt.toFixed(1)}ms em ${metrics.ttlHops} saltos.`;
      }
    } else {
      botReplyText = `[Diagnóstico Local] Recomendação tática: ${verdict.actionableTip}`;
    }

    const botMsg: ChatMessage = {
      id: (Date.now() + 1).toString(),
      sender: 'bot',
      text: botReplyText,
      timestamp: nowTime,
      isLocalOnly: true,
    };

    setMessages((prev) => [...prev, botMsg]);
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isAiLoading) return;
    if (!aiStatus.enabled) return; // Feature disabled when OPENAI_API_KEY is missing

    const query = inputText.trim();
    setInputText('');
    handleSendPrompt(query);
  };

  return (
    <div className="rounded-xl border border-cyan-900/40 bg-[#040e17] p-4 shadow-xl flex flex-col h-full min-h-[380px]">
      {/* Chat Header: Clean floating 3D robot head + status */}
      <div className="flex items-center justify-between pb-3 border-b border-cyan-900/40 shrink-0">
        <div className="flex items-center gap-3">
          {/* Borderless 3D Floating Robot Head Canvas */}
          <div
            ref={mountRef}
            className="w-16 h-16 shrink-0 relative cursor-pointer"
            onClick={() => handleSendPrompt('Como está a minha conexão agora?', 'verdict')}
            title="Robô Co-Piloto de Telemetria (Clique para status rápido)"
          />

          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold font-mono text-slate-100 uppercase">
                CO-PILOTO DE REDE // BOT-X
              </span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            </div>
            <p className="text-xs text-slate-400">
              Análise em tempo real de latência, rotas BGP e servidores Azure brazilsouth
            </p>
          </div>
        </div>

        {/* Right Header Badges */}
        <div className="flex items-center gap-2">
          {/* AI Status Badge */}
          {aiStatus.enabled ? (
            <div className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-lg border border-cyan-500/40 bg-cyan-950/40 text-[10px] font-mono text-cyan-300">
              <Sparkles className="w-3 h-3 text-cyan-400" />
              <span>OpenAI {aiStatus.model}</span>
            </div>
          ) : (
            <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg border border-amber-500/40 bg-amber-950/30 text-[10px] font-mono text-amber-300">
              <AlertTriangle className="w-3 h-3 text-amber-400" />
              <span>IA Offline</span>
            </div>
          )}

          {/* Settings Modal Button */}
          {onOpenSettings && (
            <button
              onClick={() => {
                onOpenSettings();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono transition-colors bg-[#030910] text-slate-400 hover:text-cyan-300 border-cyan-900/40 hover:border-cyan-500/40"
              title="Configurações da Chave OpenAI"
            >
              <Settings className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Configurações</span>
            </button>
          )}
        </div>
      </div>

      {/* Prominent Informational Alert Banner when AI is Disabled */}
      {aiStatus.checked && !aiStatus.enabled && (
        <div className="mt-3 p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs flex items-start gap-2.5 shrink-0 shadow-inner">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold block text-amber-300">
                IA Generativa Desabilitada (Nenhuma chave OpenAI configurada)
              </span>
              {onOpenSettings && (
                <button
                  onClick={() => {
                    onOpenSettings();
                  }}
                  className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition-colors flex items-center gap-1 shrink-0"
                >
                  <Settings className="w-3 h-3" />
                  <span>Configurar</span>
                </button>
              )}
            </div>
            <p className="text-[11px] text-amber-200/90 leading-relaxed">
              O chat com IA e voz neural está em modo local. Para ativar respostas inteligentes com OpenAI GPT-4o, clique em Configurar e insira sua chave. Todos os testes de rede continuam 100% operacionais.
            </p>
          </div>
        </div>
      )}

      {/* Interactive Chat Message Stream (Speech Balloons) */}
      <div ref={chatContainerRef} className="flex-1 overflow-y-auto py-3 space-y-3 pr-1 text-xs">
        {messages.map((msg) => {
          const isBot = msg.sender === 'bot';

          return (
            <div
              key={msg.id}
              className={`flex items-start gap-2 ${isBot ? 'justify-start' : 'justify-end'}`}
            >
              {isBot && (
                <div className="w-7 h-7 rounded-full bg-cyan-950/80 border border-cyan-500/40 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-cyan-400" />
                </div>
              )}

              <div
                className={`max-w-[85%] sm:max-w-[78%] rounded-2xl p-3 shadow-md ${
                  isBot
                    ? 'bg-[#061522] border border-cyan-900/50 text-slate-200 rounded-tl-none'
                    : 'bg-cyan-600/20 border border-cyan-500/40 text-cyan-100 rounded-tr-none ml-auto'
                }`}
              >
                <div className="flex items-center justify-between gap-4 mb-1 text-[10px] font-mono text-slate-400">
                  <span className="font-semibold text-cyan-400 flex items-center gap-1">
                    <span>{isBot ? 'BOT-X' : 'VOCÊ'}</span>
                    {msg.isLocalOnly && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-slate-800 text-slate-400 font-normal">
                        telemetria local
                      </span>
                    )}
                  </span>
                  <span>{msg.timestamp}</span>
                </div>

                <p className="leading-relaxed text-xs sm:text-sm whitespace-pre-wrap">
                  {msg.text}
                </p>

                {isBot && (
                  <div className="mt-2 pt-2 border-t border-cyan-900/30 flex items-center justify-between">
                    <span />
                    <span className="text-[10px] font-mono text-slate-500">
                      Rank {verdict.rank} · {metrics.rttMs.toFixed(1)}ms
                    </span>
                  </div>
                )}
              </div>

              {!isBot && (
                <div className="w-7 h-7 rounded-full bg-cyan-500/20 border border-cyan-400/50 flex items-center justify-center shrink-0 mt-0.5">
                  <User className="w-3.5 h-3.5 text-cyan-300" />
                </div>
              )}
            </div>
          );
        })}

        {/* Loading Indicator when OpenAI is thinking */}
        {isAiLoading && (
          <div className="flex items-start gap-2 justify-start">
            <div className="w-7 h-7 rounded-full bg-cyan-950/80 border border-cyan-500/40 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-cyan-400 animate-bounce" />
            </div>
            <div className="rounded-2xl p-3 bg-[#061522] border border-cyan-900/50 text-slate-300 rounded-tl-none flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              <span className="text-xs font-mono text-cyan-300">
                BOT-X analisando telemetria com OpenAI...
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Quick Suggestion Chips (Available in both AI and Local diagnostic modes) */}
      <div className="pt-2 border-t border-cyan-900/30 space-y-2 shrink-0">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs font-mono no-scrollbar">
          <button
            onClick={() => handleSendPrompt('É um momento bom para jogar agora ou está lotado?', 'verdict')}
            className="px-2.5 py-1 rounded-full bg-[#061522] border border-cyan-900 hover:border-cyan-400 text-slate-300 hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
          >
            🎮 Momento para jogar?
          </button>
          <button
            onClick={() => handleSendPrompt('O problema é na minha conexão ou nos servidores da Microsoft?', 'servers')}
            className="px-2.5 py-1 rounded-full bg-[#061522] border border-cyan-900 hover:border-cyan-400 text-slate-300 hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
          >
            🔍 Minha conexão vs Microsoft?
          </button>
          <button
            onClick={() => handleSendPrompt('O problema é de rota ou da minha rede local?', 'route')}
            className="px-2.5 py-1 rounded-full bg-[#061522] border border-cyan-900 hover:border-cyan-400 text-slate-300 hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
          >
            🗺️ Rota BGP vs Local?
          </button>
          <button
            onClick={() => handleSendPrompt('O que posso fazer para melhorar meu ping e jitter?', 'tips')}
            className="px-2.5 py-1 rounded-full bg-[#061522] border border-cyan-900 hover:border-cyan-400 text-slate-300 hover:text-cyan-200 transition-colors whitespace-nowrap shrink-0"
          >
            💡 Como otimizar?
          </button>
        </div>

        {/* Custom Text Input Bar - Disabled when OPENAI_API_KEY is not configured */}
        <form onSubmit={handleCustomSubmit} className="flex items-center gap-2">
          <input
            type="text"
            value={inputText}
            disabled={!aiStatus.enabled || isAiLoading}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={
              !aiStatus.enabled
                ? 'IA desabilitada (adicione OPENAI_API_KEY no .env para conversar com IA)...'
                : isAiLoading
                ? 'Aguarde, processando resposta com OpenAI...'
                : "Pergunte ao mascote com IA (ex: 'como diminuir meu ping?')..."
            }
            className={`flex-1 px-3.5 py-2 text-xs font-mono rounded-xl border focus:outline-none transition-colors ${
              !aiStatus.enabled
                ? 'bg-[#020509] border-slate-800 text-slate-500 cursor-not-allowed placeholder:text-slate-600'
                : 'bg-[#02070d] border-cyan-900/60 text-slate-200 placeholder:text-slate-600 focus:border-cyan-400'
            }`}
          />
          <button
            type="submit"
            disabled={!aiStatus.enabled || isAiLoading || !inputText.trim()}
            className={`p-2 rounded-xl transition-colors shrink-0 ${
              !aiStatus.enabled || isAiLoading || !inputText.trim()
                ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-cyan-500 text-black hover:bg-cyan-400 shadow-sm'
            }`}
            title={!aiStatus.enabled ? 'Configure OPENAI_API_KEY no .env para habilitar' : 'Enviar pergunta para IA'}
          >
            {isAiLoading ? <Loader2 className="w-4 h-4 animate-spin text-cyan-300" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
};
