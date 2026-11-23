import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LiveGameQueue, XCloudGameSearchResult } from '../types/telemetry';
import {
  fetchActiveGameQueue,
  fetchRecentGames,
  searchXCloudGames,
  fetchGameWaitTime,
} from '../services/nativeBridge';
import { playUiClick } from '../services/soundEffects';
import {
  Gamepad2,
  Clock,
  Search,
  RefreshCw,
  Sparkles,
  Server,
  CheckCircle2,
  AlertTriangle,
  Flame,
  ArrowRight,
  User,
} from 'lucide-react';

interface ActiveGameQueueWidgetProps {
  onQueueUpdated?: (queue: LiveGameQueue) => void;
  className?: string;
}

export function ActiveGameQueueWidget({ onQueueUpdated, className = '' }: ActiveGameQueueWidgetProps) {
  const [activeQueue, setActiveQueue] = useState<LiveGameQueue | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [recentGames, setRecentGames] = useState<Array<{ titleId: string; productId: string; titleName: string; posterUrl?: string }>>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<XCloudGameSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedGameWait, setSelectedGameWait] = useState<{ titleId: string; titleName: string; waitSeconds: number; waitMinutes: number; posterUrl?: string } | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [userDeclaredPlaying, setUserDeclaredPlaying] = useState<boolean | null>(null);

  // Polling ref
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load Active Game from MRU & Recent Games
  const loadActiveGame = useCallback(async (titleId?: string) => {
    setIsLoading(true);
    try {
      const queue = await fetchActiveGameQueue(titleId);
      if (queue) {
        setActiveQueue(queue);
        setRemainingSeconds(queue.estimatedWaitSeconds);
        if (onQueueUpdated) onQueueUpdated(queue);
      }
    } catch (err) {
      console.warn('Could not fetch active game queue:', err);
    } finally {
      setIsLoading(false);
    }
  }, [onQueueUpdated]);

  const loadRecentGames = useCallback(async () => {
    try {
      const recents = await fetchRecentGames();
      setRecentGames(recents.slice(0, 5));
    } catch (err) {
      console.warn('Could not fetch recent games:', err);
    }
  }, []);

  useEffect(() => {
    loadActiveGame();
    loadRecentGames();

    // Auto-poll live queue every 20 seconds
    timerRef.current = setInterval(() => {
      loadActiveGame();
    }, 20000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [loadActiveGame, loadRecentGames]);

  // Local live countdown ticker (1s decrements)
  useEffect(() => {
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    if (remainingSeconds !== null && remainingSeconds > 0) {
      countdownIntervalRef.current = setInterval(() => {
        setRemainingSeconds((prev) => {
          if (prev === null || prev <= 0) return 0;
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [remainingSeconds]);

  // Debounced Search
  useEffect(() => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    const delay = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchXCloudGames(searchQuery);
        setSearchResults(results);
      } catch (err) {
        console.warn('Search games error:', err);
      } finally {
        setIsSearching(false);
      }
    }, 350);

    return () => clearTimeout(delay);
  }, [searchQuery]);

  const handleSelectSearchedGame = async (game: XCloudGameSearchResult) => {
    playUiClick();
    setIsLoading(true);
    try {
      const wait = await fetchGameWaitTime(game.titleId);
      setSelectedGameWait({
        titleId: game.titleId,
        titleName: game.titleName,
        waitSeconds: wait.estimatedWaitSeconds,
        waitMinutes: wait.estimatedWaitMinutes,
        posterUrl: game.posterUrl,
      });
      // Also switch active tracker to this game
      loadActiveGame(game.titleId);
      setSearchQuery('');
      setSearchResults([]);
    } catch (err) {
      console.warn('Could not query wait time for game:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectRecentGame = (titleId: string) => {
    playUiClick();
    loadActiveGame(titleId);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const seconds = remainingSeconds ?? activeQueue?.estimatedWaitSeconds ?? 0;
  const isHighQueue = seconds > 300;
  const isImmediate = seconds <= 15;
  const isPlaying = userDeclaredPlaying !== null
    ? userDeclaredPlaying
    : Boolean(activeQueue?.isCurrentlyPlaying);

  return (
    <div
      className={`rounded-2xl border border-cyan-800/40 bg-gradient-to-b from-[#081827] via-[#05111d] to-[#030911] p-5 shadow-2xl relative overflow-hidden ${className}`}
    >
      {/* Background Cyber Grid Accent */}
      <div className="absolute inset-0 bg-[radial-gradient(#00e5ff_1px,transparent_1px)] [background-size:24px_24px] opacity-10 pointer-events-none" />

      {/* Header Bar */}
      <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-cyan-900/40 gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
            <Gamepad2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold font-mono tracking-wider text-slate-100 uppercase">
                FILA AO VIVO DO XCLOUD // XSTREAMING
              </h3>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                AO VIVO
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Telemetria oficial em tempo real vinda das lâminas Azure brazilsouth (São Paulo).
            </p>
          </div>
        </div>

        {/* User Info & Refresh */}
        <div className="flex items-center gap-2">
          {activeQueue?.gamertag && (
            <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-cyan-950/40 border border-cyan-800/40 text-xs font-mono text-cyan-200">
              {activeQueue.gamerpic ? (
                <img
                  src={activeQueue.gamerpic}
                  alt={activeQueue.gamertag}
                  className="w-5 h-5 rounded-full border border-cyan-400/60"
                />
              ) : (
                <User className="w-3.5 h-3.5 text-cyan-400" />
              )}
              <span className="font-semibold">{activeQueue.gamertag}</span>
            </div>
          )}

          <button
            onClick={() => {
              playUiClick();
              loadActiveGame(activeQueue?.titleId);
            }}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-mono transition-all disabled:opacity-50"
            title="Atualizar fila do servidor da Microsoft"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Atualizar</span>
          </button>
        </div>
      </div>

      {/* Main Content: Active Game Card & Queue Status */}
      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-5 mt-5 items-stretch">
        {/* Left: Active Game Poster & Live Counter (7 cols) */}
        <div className="lg:col-span-7 rounded-xl border border-cyan-900/50 bg-[#040c14]/80 p-4 flex flex-col justify-between gap-4">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4">
            {/* Poster Art */}
            <div className="relative w-24 sm:w-28 h-36 rounded-xl overflow-hidden border border-cyan-500/30 bg-[#020508] shrink-0 shadow-lg group">
              {activeQueue?.posterUrl ? (
                <img
                  src={activeQueue.posterUrl}
                  alt={activeQueue.titleName}
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 gap-1">
                  <Gamepad2 className="w-8 h-8 text-cyan-500/40" />
                  <span className="text-[10px] font-mono">Sem Imagem</span>
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
              <div className="absolute bottom-1 left-1 right-1 text-center">
                <span className="text-[9px] font-mono font-bold text-cyan-300 uppercase truncate block">
                  xCloud
                </span>
              </div>
            </div>

            {/* Game Info & Queue Breakdown */}
            <div className="flex-1 space-y-2 text-center sm:text-left min-w-0">
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950/70 border border-cyan-800/40 text-cyan-300 uppercase tracking-wider">
                  Jogo no xStreaming
                </span>
                {isPlaying ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_8px_rgba(16,185,129,0.3)]">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    VOCÊ JÁ ESTÁ CONECTADO
                  </span>
                ) : isImmediate ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    SEM FILA
                  </span>
                ) : isHighQueue ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse">
                    <Flame className="w-3 h-3 text-rose-400" />
                    PICO DE DEMANDA
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    <AlertTriangle className="w-3 h-3 text-amber-400" />
                    FILA MODERADA
                  </span>
                )}

                {/* Toggle status button */}
                <button
                  onClick={() => setUserDeclaredPlaying(prev => prev === true ? false : true)}
                  className="text-[10px] font-mono text-cyan-400/80 hover:text-cyan-300 underline ml-auto"
                  title="Alternar entre status conectado e na fila"
                >
                  {isPlaying ? "Marcar como na fila" : "Já conectou ao jogo?"}
                </button>
              </div>

              <h4 className="text-xl font-extrabold text-slate-100 tracking-tight truncate">
                {activeQueue?.titleName || 'Carregando jogo...'}
              </h4>

              <div className="text-xs font-mono text-slate-400 flex flex-wrap items-center justify-center sm:justify-start gap-x-4 gap-y-1">
                <span>
                  ID:{' '}
                  <span className="text-cyan-300 font-semibold">
                    {activeQueue?.titleId || '---'}
                  </span>
                </span>
                <span>
                  Região:{' '}
                  <span className="text-slate-200">Azure brazilsouth (SP)</span>
                </span>
              </div>

              {/* Informative Banner when User is Already in Game */}
              {isPlaying && (
                <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-xs font-mono text-emerald-200/90 flex items-start gap-2 text-left">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="font-bold text-emerald-300">
                      Você já está conectado ao jogo!
                    </p>
                    <p className="text-[11px] text-slate-300 leading-relaxed">
                      Sua sessão está ativa com console garantido no datacenter. O tempo de fila de <span className="text-amber-300 font-bold">{formatTime(seconds)} ({Math.ceil(seconds / 60)} min)</span> abaixo é a espera que <strong>novos jogadores</strong> enfrentarão caso tentem entrar agora.
                    </p>
                  </div>
                </div>
              )}

              {/* Digital Countdown Clock */}
              <div className="pt-2">
                <div className="flex items-baseline justify-center sm:justify-start gap-3">
                  <div className="text-4xl sm:text-5xl font-black font-mono tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-teal-300 to-emerald-400 drop-shadow-[0_0_15px_rgba(0,229,255,0.4)]">
                    {formatTime(seconds)}
                  </div>
                  <div className="text-xs font-mono text-slate-400 flex flex-col">
                    <span className="text-cyan-300 font-bold">
                      {isPlaying ? 'Fila para novos jogadores' : `${seconds}s restantes`}
                    </span>
                    <span>
                      {isPlaying
                        ? 'Servidores da Microsoft operando sob carga'
                        : seconds > 60
                        ? `~${Math.ceil(seconds / 60)} min para entrar`
                        : 'Entrando no console!'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Allocation Progress Bar */}
          <div className="space-y-1.5 pt-2 border-t border-cyan-950/60">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <span className="text-slate-400 flex items-center gap-1">
                <Server className="w-3.5 h-3.5 text-cyan-400" />
                Alocação de Console Xbox Series X Virtual:
              </span>
              <span className="text-cyan-300 font-semibold">
                {isPlaying
                  ? 'Console Alocado e Sessão Ativa (100%)'
                  : isImmediate
                  ? 'Pronto para Streaming (100%)'
                  : `Aguardando Vaga (${Math.max(5, Math.min(95, Math.round(100 - (seconds / 1800) * 100)))}%)`}
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-slate-900 border border-cyan-900/40 overflow-hidden relative">
              <div
                className={`h-full transition-all duration-1000 ${
                  isPlaying || isImmediate
                    ? 'bg-emerald-400 shadow-[0_0_10px_#10b981]'
                    : isHighQueue
                    ? 'bg-gradient-to-r from-rose-500 to-amber-500 shadow-[0_0_10px_#f43f5e]'
                    : 'bg-gradient-to-r from-cyan-500 to-emerald-400 shadow-[0_0_10px_#06b6d4]'
                }`}
                style={{
                  width: isPlaying || isImmediate
                    ? '100%'
                    : `${Math.max(5, Math.min(95, Math.round(100 - (seconds / 1800) * 100)))}%`,
                }}
              />
            </div>
          </div>

          {/* Quick-Switch Recent Games Pills */}
          {recentGames.length > 0 && (
            <div className="pt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-mono text-slate-500 uppercase mr-1">
                Recentes:
              </span>
              {recentGames.map((g) => (
                <button
                  key={g.titleId}
                  onClick={() => handleSelectRecentGame(g.titleId)}
                  className={`text-[11px] font-mono px-2 py-0.5 rounded-md border transition-all ${
                    activeQueue?.titleId === g.titleId
                      ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/50 font-bold'
                      : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
                  }`}
                >
                  {g.titleName}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: Search & Other Games Lookahead (5 cols) */}
        <div className="lg:col-span-5 rounded-xl border border-cyan-900/50 bg-[#040c14]/80 p-4 flex flex-col justify-between gap-3">
          <div className="space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-slate-200">
              <Search className="w-3.5 h-3.5 text-cyan-400" />
              <span>CONSULTAR FILA DE OUTROS JOGOS</span>
            </div>

            {/* Search Input */}
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por Forza, GTA, EA FC, Halo..."
                className="w-full px-3 py-2 pl-9 rounded-xl bg-slate-950/80 border border-cyan-900/60 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400 transition-colors"
              />
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5 pointer-events-none" />
              {isSearching && (
                <RefreshCw className="w-3.5 h-3.5 text-cyan-400 animate-spin absolute right-3 top-2.5" />
              )}
            </div>

            {/* Search Results Dropdown / List */}
            {searchResults.length > 0 ? (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                {searchResults.map((game) => (
                  <button
                    key={game.titleId}
                    onClick={() => handleSelectSearchedGame(game)}
                    className="w-full p-2 rounded-lg bg-slate-900/40 hover:bg-cyan-950/40 border border-slate-800/60 hover:border-cyan-800/60 flex items-center justify-between text-left transition-all group"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {game.posterUrl ? (
                        <img
                          src={game.posterUrl}
                          alt={game.titleName}
                          className="w-7 h-9 rounded object-cover border border-cyan-900/40 shrink-0"
                        />
                      ) : (
                        <div className="w-7 h-9 rounded bg-slate-800 flex items-center justify-center shrink-0">
                          <Gamepad2 className="w-3.5 h-3.5 text-slate-500" />
                        </div>
                      )}
                      <div className="truncate">
                        <p className="text-xs font-bold text-slate-200 group-hover:text-cyan-300 truncate">
                          {game.titleName}
                        </p>
                        <p className="text-[10px] font-mono text-slate-500 truncate">
                          {game.titleId}
                        </p>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-cyan-400 font-semibold flex items-center gap-1 shrink-0 ml-2">
                      Ver Fila
                      <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                    </span>
                  </button>
                ))}
              </div>
            ) : searchQuery.length >= 2 && !isSearching ? (
              <div className="p-3 text-center text-xs font-mono text-slate-500">
                Nenhum título encontrado com "{searchQuery}".
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-cyan-950/10 border border-cyan-900/30 text-xs font-mono text-slate-400 space-y-1.5">
                <p className="flex items-center gap-1.5 text-cyan-300 font-semibold">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  Dica de Jogador:
                </p>
                <p className="text-[11px] leading-relaxed">
                  Títulos muito disputados como <span className="text-slate-200 font-bold">Fortnite</span> e <span className="text-slate-200 font-bold">GTA V</span> acumulam filas longas aos sábados à noite. Jogos solo e indies costumam abrir com <span className="text-emerald-400 font-bold">0 a 10 segundos</span> de espera.
                </p>
              </div>
            )}
          </div>

          {/* Displayed Selected Lookahead */}
          {selectedGameWait && (
            <div className="p-2.5 rounded-lg bg-cyan-950/30 border border-cyan-500/40 flex items-center justify-between text-xs font-mono mt-auto">
              <div className="truncate pr-2">
                <span className="text-slate-400 text-[10px] block">Última Consulta Direta:</span>
                <span className="text-slate-100 font-bold truncate block">
                  {selectedGameWait.titleName}
                </span>
              </div>
              <div className="text-right shrink-0">
                <span className="text-emerald-400 font-bold text-sm">
                  {selectedGameWait.waitSeconds}s
                </span>
                <span className="text-[10px] text-slate-400 block">
                  ({Math.round((selectedGameWait.waitSeconds / 60) * 10) / 10} min)
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
