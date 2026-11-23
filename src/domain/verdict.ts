import { GamingRank, GamingVerdict, NetworkMetrics, RootCauseCategory, XCloudServerStatus } from '../types/telemetry';

/**
 * Target rank with strict latency rules and wide hysteresis deadbands.
 * Deadbands: F <-> B: 58ms - 70ms; B <-> A: 38ms - 48ms; A <-> S: 20ms - 25ms
 * Pure: the caller keeps the confirmation counters (a rank only changes after several consecutive cycles).
 */
export function rawRankWithHysteresis(

    currentStable: GamingRank,
    rtt: number,
    jitter: number,
    loss: number,
    isWifi24: boolean,
    bloat: number,
    hairpin: boolean,
    serverLoad: number,
    queueRisk: string
  
): GamingRank {
  // 1. Critical Hard Fault: Hairpinning always forces F
  if (hairpin) return 'F';

  // 2. Rank F State Hysteresis (Degradado ou Perda severa)
  if (currentStable === 'F') {
    // Recovery requires clean metrics below 68ms RTT and low jitter
    if (loss < 0.1 && rtt < 68.0 && jitter < 12.0 && bloat < 50.0) {
      return 'B';
    }
    return 'F';
  }

  // Drop into F from any other rank requires exceeding 75ms or severe packet loss
  if (loss >= 0.25 || rtt >= 75.0 || jitter >= 15.0 || bloat > 65.0) {
    return 'F';
  }

  // 3. Rank B State Hysteresis (Atenção)
  if (currentStable === 'B') {
    // Promotion to A requires dropping cleanly below 45ms RTT
    if (!isWifi24 && rtt < 45.0 && jitter < 5.0 && bloat <= 35.0 && !(serverLoad > 85 && queueRisk === 'HIGH')) {
      return 'A';
    }
    return 'B';
  }

  // Drop into B from A or S requires exceeding 50ms RTT or high jitter
  if (rtt >= 50.0 || isWifi24 || jitter >= 7.0 || bloat > 40.0 || (serverLoad > 85 && queueRisk === 'HIGH')) {
    return 'B';
  }

  // 4. Rank S State Hysteresis (Excelente / Ideal)
  if (currentStable === 'S') {
    if (rtt > 42.0 || jitter > 3.2 || loss > 0.0) {
      return 'A';
    }
    return 'S';
  }

  // Promotion to S from A: sub-38ms with sub-3ms jitter (exact real xCloud cluster performance)
  if (rtt <= 38.0 && jitter <= 3.0 && loss === 0.0) {
    return 'S';
  }

  return 'A';
}

export interface VerdictInput {
  metrics: NetworkMetrics;
  isHairpinning: boolean;
  serverStatus: XCloudServerStatus;
}

/** Gaming verdict and root-cause breakdown from the smoothed metrics. */
export function computeVerdict({ metrics, isHairpinning, serverStatus }: VerdictInput): GamingVerdict {
  const effectiveRtt = metrics.smoothedRttMs ?? metrics.rttMs;
  const effectiveJitter = metrics.smoothedJitterMs ?? metrics.jitterMs;

  // 1. Critical Hairpinning (BGP international detour to US)
  if (isHairpinning) {
    return {
      rank: 'F',
      headline: 'DESFAVORÁVEL: Rota Internacional Subótima (BGP Hairpinning)',
      isGoodTimeToPlay: false,
      queueStatusText: 'Atraso intolerável para jogos interativos. Seus pacotes estão indo para os EUA antes de voltar ao Brasil.',
      rootCauseCategory: 'ISP_ROUTE',
      rootCauseTitle: 'Falha de Rota do seu Provedor (BGP Hairpinning)',
      rootCauseDescription: 'Sua operadora não está entregando seu tráfego no IX.br São Paulo ou PNI direto. Seus pacotes viajam milhares de quilômetros até Miami/Atlanta antes de retornar.',
      actionableTip: 'Reinicie o modem para tentar obter uma faixa IP com tabela de rotas diferente, ou abra chamado no seu provedor citando BGP Hairpinning no AS8075.',
    };
  }

  // 2. Critical Network Degradation: High latency (>65ms), packet loss (>0.1%), or critical jitter (>15ms)
  // CRITICAL: Even if Microsoft queue is empty, high latency makes cloud gaming UNPLAYABLE
  if (metrics.packetLossPct > 0.1 || effectiveRtt >= 65.0 || effectiveJitter > 15.0) {
    return {
      rank: 'F',
      headline:
        effectiveRtt >= 65.0
          ? `DESFAVORÁVEL: Latência Crítica de Rede (${effectiveRtt.toFixed(1)}ms)`
          : 'DESFAVORÁVEL: Instabilidade Crítica na Conexão',
      isGoodTimeToPlay: false,
      queueStatusText:
        serverStatus.estimatedWaitMinutes === 0
          ? `Atenção: Os servidores da Microsoft estão com fila zerada, MAS sua latência de rede (${effectiveRtt.toFixed(1)}ms) está alta demais para cloud gaming. Você terá atraso nos comandos (input lag). Momento desfavorável para jogar!`
          : `Conexão instável com ${effectiveRtt.toFixed(1)}ms e servidores com fila. Momento desfavorável para jogar.`,
      rootCauseCategory: 'ISP_ROUTE',
      rootCauseTitle: 'Latência Crítica ou Perda no Transporte',
      rootCauseDescription: 'A latência ultrapassou 65ms (limite de tolerância a 60 FPS), gerando atraso substancial entre a ação no controle e a reação na tela.',
      actionableTip: 'Verifique se há downloads ou uploads ativos na rede local ou contate seu provedor para verificar a rota até São Paulo.',
    };
  }

  // 3. Wi-Fi 2.4GHz Instability (Local Connection Fault)
  if (metrics.isWifi24Ghz && effectiveJitter > 8.0) {
    return {
      rank: 'B',
      headline: 'ATENÇÃO: Instabilidade no Meio Sem Fio Local (Wi-Fi 2.4 GHz)',
      isGoodTimeToPlay: false,
      queueStatusText: 'Micro-travamentos e frame drops visíveis causados por interferência no canal de 2.4 GHz.',
      rootCauseCategory: 'LOCAL_CONNECTION',
      rootCauseTitle: 'Interferência Eletromagnética Local (Wi-Fi 2.4GHz)',
      rootCauseDescription: 'A latência base pode estar razoável, mas o jitter elevado na rede local faz com que os quadros de vídeo cheguem descompassados.',
      actionableTip: 'Conecte um cabo Ethernet (RJ45) ou migre seu dispositivo para a rede Wi-Fi de 5 GHz ou 6 GHz a curta distância.',
    };
  }

  // 4. Bufferbloat (Local Router Queue Saturation)
  if (metrics.bufferbloatDeltaMs > 45.0) {
    return {
      rank: 'B',
      headline: 'ATENÇÃO: Saturação de Bufferbloat no Roteador Residencial',
      isGoodTimeToPlay: false,
      queueStatusText: 'Picos súbitos de latência ocorrem sempre que alguém assiste a vídeos ou faz downloads na sua casa.',
      rootCauseCategory: 'LOCAL_CONNECTION',
      rootCauseTitle: 'Enfileiramento Excessivo no Roteador (Bufferbloat)',
      rootCauseDescription: 'Seu modem/roteador não possui gerenciamento ativo de filas (AQM). O RTT salta de forma instantânea durante picos de tráfego.',
      actionableTip: 'Pause downloads, torrents ou streaming na rede local, ou ative SQM (Smart Queue Management) / CAKE no roteador.',
    };
  }

  // 5. Borderline / Moderate Latency (45ms to 65ms)
  // CRITICAL: Even if Microsoft queue is empty, do NOT declare "ótimo"
  if (effectiveRtt >= 45.0) {
    return {
      rank: 'B',
      headline: `ATENÇÃO: Latência Elevada na Conexão (${effectiveRtt.toFixed(1)}ms)`,
      isGoodTimeToPlay: false,
      queueStatusText:
        serverStatus.estimatedWaitMinutes === 0
          ? `Atenção: Embora os servidores da Microsoft estejam sem filas, sua latência de ${effectiveRtt.toFixed(1)}ms está acima do ideal. Jogos casuais funcionam, mas jogos de tiro/ação terão atraso perceptível nos comandos. Não está ótimo!`
          : `Latência elevada de ${effectiveRtt.toFixed(1)}ms com fila estimada no servidor. Momento moderado a desfavorável.`,
      rootCauseCategory: 'ISP_ROUTE',
      rootCauseTitle: 'Latência Acima do Ideal para 60 FPS',
      rootCauseDescription: 'Atraso decorrente de rotas estendidas no interior ou trânsito intermediário de operadora.',
      actionableTip: 'Utilize conexão cabeada se possível e feche outros aplicativos que disputem largura de banda.',
    };
  }

  // 6. Microsoft Cloud Server Congestion (Queue Wait Time)
  if (serverStatus.serverLoadPercentage > 85 && serverStatus.queueRisk === 'HIGH') {
    return {
      rank: 'B',
      headline: 'FILAS ESTIMADAS: Servidores em Horário de Pico',
      isGoodTimeToPlay: false,
      queueStatusText: `Sua conexão de rede está excelente (${effectiveRtt.toFixed(1)}ms), porém o datacenter em São Paulo está com fila estimada de ~${serverStatus.estimatedWaitMinutes} minutos.`,
      rootCauseCategory: 'MICROSOFT_SERVERS',
      rootCauseTitle: 'Sobrecarga de Servidores na Nuvem Microsoft (Horário de Pico)',
      rootCauseDescription: 'O datacenter Azure brazilsouth está operando com alta ocupação. Sua internet é perfeita; a espera se deve à fila de alocação de console virtual.',
      actionableTip: 'Aguarde na fila do jogo. Uma vez dentro da sessão, a jogabilidade será fluida e de baixa latência.',
    };
  }

  // 7. Nominal State: Rank S (Peak Console Feel) or Rank A (Excellent)
  if (effectiveRtt < 22.0 && effectiveJitter < 2.5 && metrics.packetLossPct === 0.0) {
    return {
      rank: 'S',
      headline: 'MOMENTO PERFEITO PARA JOGAR (Rank S - Console Feel)',
      isGoodTimeToPlay: true,
      queueStatusText: `Conexão ultra estável (${effectiveRtt.toFixed(1)}ms RTT) e servidores operando sem filas. Sensação idêntica a console local.`,
      rootCauseCategory: 'NOMINAL',
      rootCauseTitle: 'Conexão Nominal Ótima (Sem Gargalos)',
      rootCauseDescription: 'Roteamento direto via PNI / IX.br SP, meio físico de baixa latência e servidores Azure com capacidade livre.',
      actionableTip: 'Nenhuma ação necessária. Aproveite jogos competitivos de reflexo rápido (FPS, Luta, Corrida) a 60 FPS.',
    };
  }

  return {
    rank: 'A',
    headline: 'MOMENTO EXCELENTE: Latência Baixa e Estável',
    isGoodTimeToPlay: true,
    queueStatusText: `Tempo de resposta de ${effectiveRtt.toFixed(1)}ms com trânsito estável e sem filas nos servidores.`,
    rootCauseCategory: 'NOMINAL',
    rootCauseTitle: 'Rota Nacional Estendida Otimizada',
    rootCauseDescription: 'Trânsito nacional rápido até São Paulo com jitter controlado.',
    actionableTip: 'Conexão pronta para longas sessões de gameplay.',
  };
}
