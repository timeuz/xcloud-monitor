import React, { useState } from 'react';
import { X, Copy, Check, Download, FileText, Loader2 } from 'lucide-react';
import { NetworkMetrics, StrategicEndpoint, TracerouteReport, XCloudServerStatus, GamingVerdict } from '../types/telemetry';
import { playUiClick } from '../services/soundEffects';
import { exportEvidenceReport, isTauriApp } from '../services/nativeBridge';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  metrics: NetworkMetrics;
  endpoints: StrategicEndpoint[];
  traceroute: TracerouteReport;
  serverStatus: XCloudServerStatus;
  verdict: GamingVerdict;
}

export const ReportModal: React.FC<ReportModalProps> = ({
  isOpen,
  onClose,
  metrics,
  endpoints,
  traceroute,
  serverStatus,
  verdict,
}) => {
  const [copied, setCopied] = useState(false);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceMsg, setEvidenceMsg] = useState('');

  if (!isOpen) return null;

  const dateStr = new Date().toLocaleString('pt-BR');

  const reportMarkdown = `# RELATÓRIO DE TELEMETRIA E DIAGNÓSTICO // XBOX CLOUD GAMING BRASIL
Data de Captura: ${dateStr}
Servidor Alvo: Azure brazilsouth (São Paulo - AS8075)

---

## 1. RESUMO EXECUTIVO
* Classificação: RANK ${verdict.rank} (${verdict.headline})
* Momento para Jogar: ${verdict.isGoodTimeToPlay ? 'Favorável / Recomendado' : 'Desfavorável / Degradação Ativa'}
* Fila Estimada: ${serverStatus.estimatedWaitMinutes} minutos (${serverStatus.queueMessage})
* Causa Raiz Identificada: ${verdict.rootCauseTitle}
* Diagnóstico: ${verdict.rootCauseDescription}

---

## 2. MÉTRICAS QUANTITATIVAS DA CONEXÃO
* Latência RTT Instantânea: ${metrics.rttMs.toFixed(1)} ms
* Média Móvel RTT (SMA): ${metrics.rttAvgMs.toFixed(1)} ms
* Jitter Inter-chegada (RFC 3550 EWMA): ${metrics.jitterMs.toFixed(2)} ms
* Taxa de Perda de Pacotes: ${metrics.packetLossPct.toFixed(2)}% (${metrics.samplesLost} perdidos de ${metrics.samplesSent} transmitidos)
* Delta de Bufferbloat (Loaded - Idle): +${metrics.bufferbloatDeltaMs.toFixed(1)} ms
* Meio Físico Identificado: ${metrics.isWifi24Ghz ? 'Wi-Fi 2.4 GHz (Interferência / Jitter alto)' : 'Ethernet / Wi-Fi 5GHz'}
* Número de Saltos TTL: ${metrics.ttlHops} Hops

---

## 3. SONDAGEM ESTRATÉGICA MULTI-TARGET (AS8075)
${endpoints
  .map(
    (ep) =>
      `* [${ep.category.toUpperCase()}] ${ep.label} (${ep.host}): ${
        ep.rttMs !== null ? `${ep.rttMs.toFixed(1)} ms` : 'TIMEOUT'
      } [${ep.status}]`
  )
  .join('\n')}

---

## 4. RASTREAMENTO HOP-BY-HOP & ANÁLISE BGP
* Status da Rota: ${traceroute.isHairpinning ? 'ALERTA: BGP Hairpinning / Desvio Internacional detectado!' : 'Rota Nacional Direta (IX.br SP / PNI)'}
* Resumo: ${traceroute.summary}

Saltos Inspecionados:
${traceroute.hops
  .map((hop) => `  Hop #${hop.ttl} [${hop.rttMs.toFixed(1)} ms] -> ${hop.host} (${hop.ip}) - ${hop.location}`)
  .join('\n')}

---
Gerado por xCloud Cyber-Monitor Telemetry Suite (Compatível com especificação XCLOUD.md e r/xcloud).
`;

  const handleCopy = () => {
    playUiClick();
    navigator.clipboard.writeText(reportMarkdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    playUiClick();
    const blob = new Blob([reportMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xcloud-telemetria-diagnostico-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-xl border border-cyan-500/40 bg-[#050d14] p-5 shadow-2xl flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-3 border-b border-cyan-900/40">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-cyan-400" />
            <h3 className="text-base font-bold font-mono text-slate-100 uppercase">
              RELATÓRIO TÉCNICO PARA PROVEDOR (ISP) & r/xcloud
            </h3>
          </div>
          <button
            onClick={() => {
              playUiClick();
              onClose();
            }}
            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Evidence report built from the stored history (desktop only) */}
        {isTauriApp() && (
          <div className="mt-4 p-3 rounded-lg border border-cyan-500/40 bg-cyan-950/30 text-xs font-mono text-slate-300 space-y-2">
            <p className="leading-relaxed">
              <b className="text-cyan-300">Para abrir chamado na operadora, use o relatório de evidência.</b> O texto
              abaixo é só uma foto deste instante. O relatório de evidência usa o histórico gravado (dias de medição) e
              compara seu roteador, o 1º salto do ISP e o servidor xCloud ao mesmo tempo.
            </p>
            <button
              type="button"
              disabled={evidenceBusy}
              onClick={async () => {
                playUiClick();
                setEvidenceBusy(true);
                setEvidenceMsg('');
                try {
                  const path = await exportEvidenceReport();
                  setEvidenceMsg(`Salvo em ${path}. Abra no navegador e use Imprimir > Salvar como PDF.`);
                } catch (err: any) {
                  setEvidenceMsg(`Erro: ${err?.message || err}`);
                } finally {
                  setEvidenceBusy(false);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-black disabled:opacity-50"
            >
              {evidenceBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              <span>Gerar relatório de evidência (HTML)</span>
            </button>
            {evidenceMsg && <p className="text-cyan-300 break-all">{evidenceMsg}</p>}
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto mt-4 p-3 rounded-lg bg-[#03070a] border border-cyan-950 text-xs font-mono text-slate-300 leading-relaxed whitespace-pre-wrap select-all">
          {reportMarkdown}
        </div>

        {/* Modal Footer */}
        <div className="mt-4 pt-3 border-t border-cyan-900/40 flex items-center justify-between">
          <span className="text-xs text-slate-400 font-mono">
            Resumo do momento atual (não substitui o relatório de evidência).
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copiado!' : 'Copiar Texto'}</span>
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Baixar .MD</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
