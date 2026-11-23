import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { UpdateInfo, checkForUpdate, fetchAppVersion, installUpdate, isTauriApp, openReleasesPage } from '../services/nativeBridge';
import { playUiClick } from '../services/soundEffects';

/** Manual "check for updates" with the installed version. Desktop only. */
export const UpdateSettings: React.FC = () => {
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (isTauriApp()) fetchAppVersion().then(setVersion).catch(() => {});
  }, []);

  if (!isTauriApp()) return null;

  return (
    <div className="space-y-2 rounded-xl border border-cyan-900/40 bg-[#030910] p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-slate-300">Atualizações</span>
        <span className="text-[11px] font-mono text-slate-500">versão instalada: {version ? `v${version}` : '—'}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-400">
        O app procura versões novas no GitHub e só instala pacotes com assinatura válida do projeto. A verificação automática acontece ao abrir e a cada 6 horas.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            playUiClick();
            setBusy(true);
            setMessage('');
            setUpdate(null);
            try {
              const found = await checkForUpdate();
              setUpdate(found);
              setMessage(found ? `Versão ${found.version} disponível.` : 'Você já está na versão mais recente.');
            } catch (err: any) {
              setMessage(`Não foi possível verificar: ${err?.message || err}`);
            } finally {
              setBusy(false);
            }
          }}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-950 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-700/40 flex items-center gap-1.5 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span>Verificar atualizações</span>
        </button>
        {update &&
          (update.installable ? (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                playUiClick();
                setBusy(true);
                try {
                  await installUpdate();
                } catch (err: any) {
                  setMessage(err?.message || String(err));
                  setBusy(false);
                }
              }}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-black disabled:opacity-50"
            >
              Atualizar e reiniciar
            </button>
          ) : (
            <button
              type="button"
              onClick={() => openReleasesPage().catch((err) => setMessage(String(err)))}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-200"
            >
              Abrir página de releases
            </button>
          ))}
      </div>
      {message && <p className="text-[11px] font-mono text-cyan-300 break-words">{message}</p>}
    </div>
  );
};
