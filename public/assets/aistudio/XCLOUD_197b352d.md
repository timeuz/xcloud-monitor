Especificação Técnica e Arquitetura de Software: Aplicação Python TUI para Monitoramento do Xbox Cloud Gaming no Brasil

1. Objetivos do Sistema e Escopo Técnico de Telemetria

A prestação de serviços de jogos em nuvem (cloud gaming), como o Xbox Cloud Gaming (xCloud), impõe exigências extremas à infraestrutura de rede subjacente. Por se tratar de um sistema computacional altamente distribuído e sensível à latência, responsável pela transmissão de um fluxo de vídeo interativo em tempo real a 60 quadros por segundo (FPS), qualquer degradação na entrega de pacotes de rede resulta no comprometimento imediato da experiência do usuário (QoE - Quality of Experience). Nesse cenário, a implementação de uma telemetria contínua e não intrusiva no nível do cliente torna-se indispensável. A escolha pelo desenvolvimento de uma aplicação Python baseada em Interface de Usuário em Texto (TUI - Text-based User Interface) justifica-se pela sua extrema eficiência operacional, operando com consumo mínimo de recursos de CPU e GPU. Isso garante que as rotinas de sondagem de rede e renderização no terminal não concorram com os processos críticos de decodificação de vídeo via hardware executados pelo cliente de jogo.

O objetivo primário desta ferramenta é realizar a captura, o processamento estatístico e a exibição gráfica e textual contínua das métricas de desempenho de rede diretamente no terminal, utilizando os ecossistemas dos frameworks Textual e Rich. O escopo do sistema abrange a monitoração e a caracterização em tempo real de três variáveis fundamentais de desempenho de rede:

1. Latência de Ir e Volta (Round-Trip Time - RTT): Medição do tempo absoluto decorrido entre o envio de um pacote de sondagem a partir do cliente e o recebimento de sua respectiva confirmação pela infraestrutura de nuvem.
2. Variação de Atraso (Jitter): Inconstância estatística no tempo de chegada de pacotes consecutivos, identificando instabilidades nas filas de roteamento e comutação da malha de transporte.
3. Taxa de Perda de Pacotes (Packet Loss %): Percentual de datagramas não entregues no tempo limite pré-determinado (timeout), identificando descartes por saturação de buffers ou falhas físicas/lógicas nos enlaces.

Matriz de Métricas Primárias

Métrica	Unidade de Medida	Mecanismo de Captura	Impacto na Experiência do Usuário (QoE)
Latência (RTT)	Milissegundos (ms)	Sockets ICMP / TCP / UDP via aioping e asyncio.sockets	Elevação direta do input lag, gerando desfasamento perceptível entre os comandos executados pelo jogador e a resposta na tela.
Variação de Atraso (Jitter)	Milissegundos (ms)	Delta de RTTs consecutivos / Média Móvel Exponencial (RFC 3550)	Inconstância na entrega dos quadros de vídeo (frame pacing desorganizado), resultando em micro-congelamentos visuais e engasgos (micro-stuttering).
Perda de Pacotes	Percentual (%)	Razão entre pacotes sem resposta e total de datagramas enviados	Surgimento de artefatos de compressão de vídeo (macrobloqueamento/pixelação), quebras brutas de resolução e degradação contínua da imagem.

A compreensão minuciosa do escopo dessas métricas quantitativas viabiliza sua correlação com a topologia física e lógica que sustenta a infraestrutura global e nacional do Xbox Cloud Gaming.

2. Contexto da Infraestrutura do Xbox Cloud Gaming e Pontos de Interconexão no Brasil

A entrega de baixa latência do Xbox Cloud Gaming no Brasil apoia-se centralmente na infraestrutura global da Microsoft (AS8075), tendo como hub primário de processamento, renderização e computação de jogos a região Azure brazilsouth, sediada no estado de São Paulo. Como o processamento gráfico do jogo é realizado inteiramente nos data centers dessa região, a qualidade final da experiência do usuário depende da eficiência do roteamento BGP (Border Gateway Protocol) e da capacidade dos links entre os Provedores de Serviços de Internet (ISPs) nacionais e a borda da rede do AS8075.

+-----------------------------------------------------------------------------------+
|                              PROVEDOR DE INTERNET (ISP)                           |
+-----------------------------------------------------------------------------------+
       |                                 |                                 |
       | (PNI 100 Gbps)                  | (IX.br SP - AS26162)            | (MAPS)
       v                                 v                                 v
+-----------------------+     +-----------------------+     +-----------------------+
|  PNI Direto com ISPs  |     | Peering Público IX.br |     | Microsoft Azure       |
| (Claro, Vivo, TIM,    |     | (PIX Equinix SP1-SP4, |     | Peering Service       |
|  Vtal)                |     |  Ascenty, Elea, etc.) |     | (Cold-Potato Routing) |
+-----------------------+     +-----------------------+     +-----------------------+
       |                                 |                                 |
       +---------------------------------+---------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                     REDE DE BORDA GLOBAL MICROSOFT (AS8075)                       |
|                          Região Azure: brazilsouth (SP)                           |
+-----------------------------------------------------------------------------------+


Análise da Rede de Borda e Modalidades de Interconexão

As conexões entre os ISPs brasileiros e o AS8075 ocorrem por meio de três modalidades estratégicas de interconexão de rede:

1. Peering Privado (PNI - Private Network Interconnect): Links diretos e dedicados de alta capacidade (tipicamente arranjos de múltiplas interfaces de 100 Gbps) estabelecidos entre a infraestrutura da Microsoft e as maiores operadoras de telecomunicações do país: Claro (AS22085), Vivo (AS26599), TIM (AS26616) e Vtal. O PNI contorna os pontos de estrangulamento de trocas de tráfego públicas, oferecendo deterministicidade de rota, latência mínima e ausência de jitter por congestionamento de terceiros.
2. Peering Público no IX.br São Paulo: Interconexão através do Ponto de Troca de Tráfego de São Paulo (AS-IXBR-SP / AS26162), considerado um dos maiores ecossistemas de peering público do mundo, integrando 1.728 membros participantes. Provedores regionais e de médio porte utilizam o IX.br SP para trocar tráfego diretamente com os routers de borda do AS8075 instalados nos PIX (Pontos de Interconexão de Troca de Tráfego).
3. Microsoft Azure Peering Service (MAPS): Estratégia de roteamento corporativo e residencial qualificado que impõe a política de cold-potato. Nessa abordagem, o ISP entrega o tráfego do usuário na rede global da Microsoft no ponto geograficamente mais próximo da origem. A partir desse ingresso precoce, o tráfego transita exclusivamente pelo backbone privado e otimizado da Microsoft até atingir os clusters de renderização no Azure brazilsouth.

Mapeamento Lógico e Geográfico de Interconexão

A infraestrutura crítica de interconexão, hospedagem e serviços essenciais do Azure e do AS8075 na Grande São Paulo engloba os seguintes ativos físicos e lógicos:

* Data Centers Equinix (SP1, SP2, SP3, SP4): Complexos primários que abrigam PIX centrais do IX.br SP e concentram as portas de interconexão direta (PNI) da Microsoft com operadoras de longo curso.
* Complexos Ascenty (AS28634 / AS52930): Instalações de alta densidade que concentram enlaces metro-ethernet e abrigam nós de ampliação da nuvem Azure.
* Data Centers Elea Digital: Infraestrutura complementar de data centers urbanos atrelada aos anéis de fibra de baixa latência da região metropolitana.
* PIX do NIC.br e Serviços Anycast: Estruturas centrais operadas pelo NIC.br (AS11752) que hospedam os servidores DNS raiz em Anycast no Brasil, incluindo os nós d.dns.br (AS11644), e.dns.br (AS12136) e f.dns.br (AS14650), fundamentais para a resolução veloz dos endpoints do streaming.

A distribuição física desses pontos de presenças determina os patamares nominais de latência, servindo de sustentáculo para a definição rigorosa dos limiares de desempenho do sistema.

3. Definição Completa dos Limiares de Desempenho e Classificação de Qualidade

Para viabilizar uma renderização remota fluida a 60 FPS, a aplicação de monitoramento exige um orçamento de latência (latency budget) total extremamente contido. O ciclo completo de interação compreende: recepção dos comandos de entrada (input), empacotamento, transporte via rede, processamento/renderização do quadro no servidor Azure brazilsouth, codificação de vídeo, transporte de retorno e decodificação no dispositivo do usuário.

Matriz Rígida de Limiares de Desempenho

Categoria de Qualidade	Latência (RTT)	Variação de Atraso (Jitter)	Perda de Pacotes	Tempo de Decodificação	Delta de Bufferbloat
Boa (Ideal)	< 20 ms (ou < 40 ms em rotas nacionais estendidas)	< 2 ms	0,00%	< 5 ms	< 5 ms
Atenção (Aceitável)	20 ms a 50 ms	2 ms a 10 ms	< 0,05%	N/D (Via Socket Network Probes)	5 ms a 25 ms
Ruim (Crítica)	> 60 ms (Alerta especial para > 120-150 ms)	> 15 ms	> 0,10%	N/D (Via Socket Network Probes)	> 50 ms

Nota sobre a métrica de Tempo de Decodificação: Na arquitetura deste sistema de monitoramento, o Tempo de Decodificação é sinalizado como N/D (Não Definido / Inatingível via sondas de rede puras) nas categorias de "Atenção" e "Ruim". Isso ocorre porque requisições assíncronas baseadas em sockets de rede no nível de transporte/rede (ICMP, TCP, UDP) operam de forma isolada da pilha de reprodução de mídia da aplicação cliente. A medição da latência de decodificação de vídeo do hardware exige integração nativa com as APIs do reprodutor do Xbox ou interceptação dos relatórios RTCStatsReport fornecidos por motores WebRTC/HTML5, sendo impossível inferi-la isoladamente através de probes de rede.

Análise Transformativa de Impacto ("So What?")

* Análise da Latência (RTT): Quando o RTT situa-se abaixo de 20 ms, o atraso total da cadeia aproxima-se da resposta de um console local. Quando o RTT excede 60 ms, a dessincronização motora torna jogos de reflexo rápido inviáveis. Patamares entre 120 ms e 150 ms ativam alertas críticos na TUI, pois indicam falhas gravíssimas de roteamento na camada BGP.
* Análise do Jitter: A variação de atraso superior a 15 ms impede que os buffers de recepção do cliente estabilizem o ritmo de entrega dos quadros. O resultado é o estrangulamento da cadência de vídeo (frame pacing), forçando a repetição de quadros antigos e causando solavancos na imagem.
* Análise da Perda de Pacotes: O streaming do Xbox Cloud Gaming utiliza algoritmos de codificação de vídeo interativo preditivo. Perdas de pacotes acima de 0,10% resultam na destruição de pacotes de referência (P-Frames ou I-Frames). Como o tempo real impede a retransmissão via TCP, o decodificador de vídeo descarta os blocos corrompidos, provocando quebras na imagem (macrobloqueamento), linhas verdes ou stuttering severo.
* Análise do Bufferbloat: O acúmulo de pacotes em roteadores sem mecanismos de enfileiramento inteligente (Active Queue Management - AQM) faz com que rajadas de tráfego de upload/download elevem temporariamente o RTT. Um Delta de Bufferbloat > 50 ms introduz picos instantâneos de lag no momento em que a aplicação envia comandos mais complexos ou recebe picos de dados.

Esses parâmetros quantitativos norteiam o motor heurístico de diagnóstico projetado para identificar as falhas mais recorrentes nas conexões residenciais brasileiras.

4. Diagnóstico e Triagem de Anomalias de Rede em Solo Nacional

A infraestrutura de telecomunicações no Brasil possui particularidades geográficas e operacionais que geram gargalos específicos até o ecossistema Azure brazilsouth. A aplicação TUI deve executar rotinas automáticas de triagem heurística para isolar as causas raiz dessas degradações.

Identificação e Análise de Falhas Críticas

1. International Hairpinning (BGP Subótimo)

Fenômeno anômalo de roteamento onde pacotes originados no Brasil com destino à região Azure brazilsouth (São Paulo) são indevidamente exportados para fora do país devido a falhas na engenharia de tráfego dos ISPs, vazamento de prefixos (prefix leaks) ou anúncios BGP incorretos. Tráfegos nacionais são desviados para os Estados Unidos, passando por pontos de interconexão em Atlanta no ecossistema AS8075 (CIX-ATL / IX-1668) ou em Ashburn (Digital Realty Ashburn / IX-2572), para só então retornar ao Brasil via cabo submarino. Esse desvio acrescenta uma imensa distância física à rota, fazendo com que a latência salte do valor esperado (10-30 ms) para a faixa de 120 ms a 150 ms, inutilizando a transmissão de jogos em tempo real.

ROTA NORMAL (Ideal):
[Cliente Brasil] ----(Rede Nacional / IX.br SP)----> [Azure brazilsouth - SP] (RTT < 20-40 ms)

ROTA SUBÓTIMA (International Hairpinning):
[Cliente Brasil] --(Cabo Submarino)--> [EUA: Atlanta CIX-ATL / Ashburn] --(Retorno)--> [Azure brazilsouth - SP] (RTT: 120-150 ms)


2. Saturação por Bufferbloat

Ocorre quando os buffers de memória de roteadores residenciais ou modems de operadoras são superdimensionados e mal gerenciados. Quando a rede do usuário entra em carga (downloads em segundo plano, atualizações de sistema ou envios de arquivos), o roteador enfileira excessivamente os datagramas em vez de descarta-los controladamente. O teste de "Delta de Bufferbloat" realiza a medição contínua da latência em repouso (idle RTT) contra a latência sob estresse sintético (loaded RTT). A variação acentuada (> 50 ms) confirma a incapacidade do equipamento de borda residencial em priorizar tráfego sensível à latência.

3. Meios de Acesso sem Fio vs. Cabeado

Conexões Wi-Fi na frequência de 2.4 GHz enfrentam gargalos físicos decorrentes do espectro poluído, sobreposição de canais e interferência eletromagnética residencial (fornos de micro-ondas, telefones sem fio e redes vizinhas). A perda de coerência de fase e os reenvios da camada MAC (Medium Access Control) geram surtos recorrentes de jitter e perdas pontuais de pacotes. Em contrapartida, interfaces de rede cabeada Gigabit Ethernet ou links Wi-Fi de 5 GHz / 6 GHz (802.11ac/ax) garantem o isolamento do meio físico e estabilidade no pacing de entrega dos pacotes.

4. Topologia de Endereçamento (CGNAT IPv4 vs. IPv6)

Devido ao esgotamento dos endereços IPv4 públicos, grande parte dos provedores no Brasil implementou a arquitetura CGNAT (Carrier-Grade NAT / NAT444). A tradução constante de portas e IP por roteadores intermediários das operadoras sobrecarrega as tabelas de estado das caixas de CGNAT, resultando em quedas repentinas de conexões UDP e incremento na latência de processamento de pacotes. Por outro lado, a adoção do IPv6 nativo proporciona roteamento direto end-to-end (ponto a ponto), contornando as camadas de NAT intermediário e garantindo menor tempo de trânsito na rede de acesso.

A mitigação e o diagnóstico em tempo real dessas falhas demandam a construção de uma arquitetura de software em Python moderna, orientada a eventos e estritamente assíncrona.

5. Arquitetura do Software Python, Bibliotecas e Especificações de Código

Para garantir que a aplicação TUI renderize suas interfaces visuais de forma contínua a 60 FPS sem congelar a tela do terminal durante a execução de medições de rede intensivas, o sistema utiliza um modelo de concorrência puramente assíncrono embasado na biblioteca asyncio. A Engine de Medição (Background Worker) e a Camada de Renderização visual operam de forma estritamente desacoplada através do loop de eventos.

Modelagem de Arquitetura Assíncrona e Bibliotecas

+-----------------------------------------------------------------------------------+
|                            LOOP DE EVENTOS (asyncio)                              |
+-----------------------------------------------------------------------------------+
       |                                                               |
       v                                                               v
+-------------------------------------+             +-------------------------------+
|     ENGINE DE MEDIÇÃO DE REDE       |             |    CAMADA DE RENDERIZAÇÃO     |
|         (Background Worker)         |             |             (TUI)             |
+-------------------------------------+             +-------------------------------+
| - Sondagens ICMP / TCP / UDP        |             | - Framework Textual           |
| - aioping / asyncio.sockets         |--asyncio--->| - Tabelas & Layouts Rich      |
| - Scapy (Traceroute / TTL Checks)   |   Queue     | - Atualização Reativa da UI   |
| - Medição Sintética de Bufferbloat  |             | - Painel Telemetria r/xcloud  |
+-------------------------------------+             +-------------------------------+


* Framework TUI (Textual & Rich): O Textual provê a arquitetura orientada a componentes, o gerenciamento do loop de eventos reativo e a estruturação de Widgets com propriedades reativas (@reactive). O Rich é responsável pela estilização de tabelas, renderização de gráficos em barras no terminal e formatação avançada dos componentes textuais.
* Engine de Sondagem de Rede (aioping, asyncio.sockets, scapy):
  * aioping: Utilizado para o disparo assíncrono e de ultrabaixo consumo de requisições ICMP echo-request/reply, ideal para a medição rápida e contínua do RTT e Jitter.
  * asyncio.sockets: Empregado para inspecionar handshakes TCP/UDP e estabelecer rajadas controladas de tráfego assíncrono sem bloqueio de I/O.
  * scapy: Empregado especificamente para tarefas de diagnóstico de baixo nível que exigem manipulação e confecção de pacotes customizados — tal como o disparo de traceroutes baseados na alteração sequencial do campo TTL (Time to Live) para detecção pontual de saltos de hops decorrentes de desvios BGP (International Hairpinning).

Formulário Matemático para Métricas em Tempo Real

A engine de processamento estatístico deve implementar rigorosamente as seguintes equações matemáticas:

1. Cálculo da Latência Instantânea e Média Móvel

A latência instantânea RTT_k de uma amostra k é dada pelo diferencial entre o instante de envio do datagrama (t_{envio}) e a confirmação de recebimento (t_{recebimento}):

RTT_k = t_{recebimento} - t_{envio}

A Média Móvel Simples (\overline{RTT}) contínua sobre uma janela deslizante de N amostras é calculada como:

\overline{RTT} = \frac{1}{N} \sum_{i=1}^{N} RTT_i

2. Variação de Atraso (Jitter) por Média Móvel Exponencialmente Ponderada (EWMA)

Alinhado à especificação da RFC 3550 (seção 6.4.1), o jitter inter-chegada estocástico J_k para a amostra k é calculado de forma incremental, aplicando um filtro constante de suavização (1/16):

D_k = |RTT_k - RTT_{k-1}|

J_k = J_{k-1} + \frac{D_k - J_{k-1}}{16}

3. Taxa Percentual de Perda de Pacotes

Calculada como a proporção entre o número de pacotes sem resposta dentro da janela de timeout (P_{perdidos}) e o total absoluto de pacotes transmitidos (P_{enviados}):

P_{loss} = \left( \frac{P_{perdidos}}{P_{enviados}} \right) \times 100

Medição Concorrente da Saturação por Bufferbloat

Para medir o Delta de Bufferbloat sem esgotar a banda da conexão do usuário ou causar auto-congestionamento catastrófico da rede, o worker assíncrono executa uma rajada leve e controlada de conexões HTTP/TCP concorrentes (asyncio.open_connection). Enquanto a rajada sintética está ativa por um janela curta (ex: 1,5 segundo), a engine dispara sondagens ICMP em paralelo. O Delta de Bufferbloat é a diferença simples entre a latência sob carga (\overline{RTT}_{loaded}) e a latência em repouso (\overline{RTT}_{idle}):

\Delta_{\text{Bufferbloat}} = \overline{RTT}_{loaded} - \overline{RTT}_{idle}

Mecanismo de Transferência de Dados Seguro entre Thread/Async e UI

Para impedir travamentos ou cintilações (flickering) na renderização gráfica do Textual, a transferência de dados entre o motor de sondagem de rede e a interface gráfica deve utilizar uma fila assíncrona desacoplada (asyncio.Queue). Alternativamente, em aplicações Textual, o motor de medição pode ser encapsulado como uma tarefa trabalhadora gerenciada pelo decorador @work do framework, atualizando propriedades reativas (@reactive) montadas nos widgets visuais. Esse modelo assegura que atualizações da UI ocorram estritamente no thread principal de renderização.

Especificação do Código Python e Engine de Diagnóstico Heurístico

O código a seguir apresenta a implementação técnica completa do motor assíncrono de sondagem, o cálculo estatístico de métricas em tempo real, o painel de contexto do cliente (inspirado nos parâmetros de comunidade do r/xcloud) e o algoritmo heurístico multilabel com ponderação por severidade para desambiguação de falhas simultâneas:

from __future__ import annotations
import asyncio
import time
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
import aioping

@dataclass
class ClientContextMetadata:
    """Metadados do ambiente do usuário baseados no r/xcloud telemetry inputs."""
    device_os: str = "Linux / Ubuntu 22.04 LTS"
    execution_medium: str = "Browser Google Chrome v122.0"
    browser_extensions: List[str] = field(default_factory=lambda: ["uBlock Origin", "xCloud Better extension"])
    app_version: str = "N/A (Web Client)"
    client_region: str = "São Paulo, Brasil"

@dataclass
class NetworkMetrics:
    """Estrutura contendo o estado quantitativo atualizado da rede."""
    rtt_ms: float = 0.0
    jitter_ms: float = 0.0
    packet_loss_pct: float = 0.0
    bufferbloat_delta_ms: float = 0.0
    is_wifi_2_4ghz: bool = False
    ttl_hop_count: int = 0
    samples_sent: int = 0
    samples_lost: int = 0

class NetworkDiagnosticEngine:
    """Engine heurística com sistema multilabel e ponderação por severidade."""

    def __init__(self, target_host: str = "8.8.8.8"):
        self.target_host = target_host
        self.metrics = NetworkMetrics()
        self.context = ClientContextMetadata()
        self.last_rtt: Optional[float] = None

    def process_raw_sample(self, raw_rtt: float | None):
        """Atualiza RTT, EWMA Jitter e Loss baseado no recebimento de datagramas."""
        self.metrics.samples_sent += 1
        
        if raw_rtt is None:
            self.metrics.samples_lost += 1
            self.metrics.packet_loss_pct = (self.metrics.samples_lost / self.metrics.samples_sent) * 100.0
            return

        # Atualiza Latência Instantânea (RTT)
        self.metrics.rtt_ms = raw_rtt
        self.metrics.packet_loss_pct = (self.metrics.samples_lost / self.metrics.samples_sent) * 100.0

        # Cálculo do Jitter via EWMA conforme RFC 3550
        if self.last_rtt is not None:
            d_k = abs(self.metrics.rtt_ms - self.last_rtt)
            self.metrics.jitter_ms = self.metrics.jitter_ms + (d_k - self.metrics.jitter_ms) / 16.0
        self.last_rtt = self.metrics.rtt_ms

    async def measure_bufferbloat_burst(self) -> float:
        """Executa uma rajada assíncrona leve para medir o Delta de Bufferbloat sob carga."""
        idle_rtt = self.metrics.rtt_ms
        loaded_rtts: List[float] = []

        async def lightweight_stream_probe():
            try:
                reader, writer = await asyncio.open_connection("www.microsoft.com", 80)
                writer.write(b"GET / HTTP/1.1\r\nHost: www.microsoft.com\r\n\r\n")
                await writer.drain()
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

        # Dispara rajadas de conexões simultâneas controladas
        burst_tasks = [lightweight_stream_probe() for _ in range(5)]
        
        # Mede latência durante o estresse de E/S
        t0 = time.perf_counter()
        try:
            rtt_sample = await aioping.ping(self.target_host, timeout=1.0)
            loaded_rtts.append(rtt_sample * 1000.0)
        except TimeoutError:
            pass
        
        await asyncio.gather(*burst_tasks, return_exceptions=True)
        
        if loaded_rtts:
            loaded_rtt_avg = sum(loaded_rtts) / len(loaded_rtts)
            delta = max(0.0, loaded_rtt_avg - idle_rtt)
            self.metrics.bufferbloat_delta_ms = delta
            return delta
        return 0.0

    def evaluate_diagnostics(self) -> Dict[str, Any]:
        """Avalia falhas concorrentes gerando diagnósticos multilabel ordenados por severidade."""
        detected_anomalies = []
        
        # 1. Checagem Crítica: International Hairpinning (BGP Subótimo)
        if 120.0 <= self.metrics.rtt_ms <= 150.0:
            detected_anomalies.append({
                "severity": 1,
                "code": "BGP_HAIRPINNING",
                "alert": "ALERTA CRÍTICO: Rota BGP Subótima (International Hairpinning)",
                "cause": "Tráfego para São Paulo desviado para PoPs nos EUA (Atlanta CIX-ATL / Ashburn)."
            })

        # 2. Checagem Crítica: Perda de Pacotes Severa
        if self.metrics.packet_loss_pct > 0.10:
            detected_anomalies.append({
                "severity": 2,
                "code": "HIGH_PACKET_LOSS",
                "alert": "Perda de Pacotes Elevada (>0.10%)",
                "cause": "Descarte de pacotes no enlace de acesso ou gargalo no provedor."
            })

        # 3. Checagem Alta: Saturação por Bufferbloat
        if self.metrics.bufferbloat_delta_ms > 50.0:
            detected_anomalies.append({
                "severity": 3,
                "code": "BUFFERBLOAT_SATURATION",
                "alert": "Saturação de BufferBloat no Roteador",
                "cause": "Enfileiramento excessivo de dados sob carga de upload/download."
            })

        # 4. Checagem Média: Instabilidade em Meio Sem Fio (Wi-Fi 2.4 GHz)
        if self.metrics.is_wifi_2_4ghz and self.metrics.jitter_ms > 15.0:
            detected_anomalies.append({
                "severity": 4,
                "code": "WIFI_24GHZ_INSTABILITY",
                "alert": "Instabilidade de Meio Físico Wi-Fi 2.4 GHz",
                "cause": "Interferência eletromagnética ou sobreposição de canais sem fio."
            })

        # Determinação do Status Global baseado no item de maior severidade
        if not detected_anomalies:
            global_status = "BOA"
            main_root_cause = "Conexão Estável com Parâmetros Ideais"
        else:
            # Ordena por severidade (menor número = maior prioridade)
            detected_anomalies.sort(key=lambda x: x["severity"])
            global_status = "RUIM" if detected_anomalies[0]["severity"] <= 2 else "ATENÇÃO"
            main_root_cause = detected_anomalies[0]["cause"]

        return {
            "status": global_status,
            "anomalies": detected_anomalies,
            "primary_root_cause": main_root_cause,
            "metrics_snapshot": self.metrics,
            "context_snapshot": self.context
        }

async def network_measurement_worker(
    engine: NetworkDiagnosticEngine, 
    data_queue: asyncio.Queue
):
    """Loop assíncrono de background que executa sondagens e atualiza a fila de UI."""
    loop_count = 0
    while True:
        try:
            # Medição contínua via ICMP aioping
            delay = await aioping.ping(engine.target_host, timeout=1.5)
            engine.process_raw_sample(delay * 1000.0)
        except TimeoutError:
            engine.process_raw_sample(None)

        # A cada 10 ciclos, executa teste de Bufferbloat concorrente
        loop_count += 1
        if loop_count % 10 == 0:
            await engine.measure_bufferbloat_burst()

        # Avalia estado e injeta na fila assíncrona thread-safe
        diagnostic_payload = engine.evaluate_diagnostics()
        await data_queue.put(diagnostic_payload)

        await asyncio.sleep(1.0)


6. Síntese e Diretrizes Finais para Desenvolvedores

Para garantir uma implementação com nível de produção, os desenvolvedores de infraestrutura e software devem seguir rigorosamente os seguintes padrões de engenharia:

1. Tratamento de Privilégios de Sockets no Sistema Operacional: A criação de sockets ICMP puros (socket.AF_INET, socket.SOCK_RAW) em sistemas operacionais baseados em Linux exige permissões elevadas. Para evitar a prática nociva de executar a aplicação TUI como usuário root ou via sudo, a equipe de implantação deve conceder privilégios granulares de rede diretamente ao interpretador Python da aplicação via Linux Capabilities:

sudo setcap cap_net_raw+ep $(which python3)


1. Separação Rígida de Arquitetura: A camada visível do terminal (Textual / Rich) deve agir de forma absolutamente desacoplada dos mecanismos de rede. Componentes visuais devem apenas escutar os dados recebidos da asyncio.Queue ou reagir a atualizações de propriedades (@reactive), proibindo terminantemente a chamada de operações síncronas ou bloqueantes no thread de renderização gráfica.
2. Deslocamento e Diagnóstico via Scapy: A utilização do scapy deve ser restrita às rotinas sob demanda de verificação do número de saltos (hops) no cabeçalho IP. Ao detectar um RTT entre 120 ms e 150 ms, a aplicação deve disparar silenciosamente um traceroute assíncrono via Scapy configurando incrementos de TTL, confirmando se o tráfego atingiu os PoPs norte-americanos (CIX-ATL ou Ashburn) para validar a presença de International Hairpinning.
