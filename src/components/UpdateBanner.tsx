import React, { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { UpdateInfo, checkForUpdate, installUpdate, isTauriApp, openReleasesPage } from '../services/nativeBridge';

const FIRST_CHECK_MS = 15_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

/** Quiet background check; shows a dismissible banner only when a newer signed release exists. */
export const UpdateBanner: React.FC = () => {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const check = useCallback(async () => {
    try {
      const found = await checkForUpdate();
      setUpdate(found);
    } catch (err) {
      // No release yet, offline, GitHub down: nothing to tell the user, try again later.
      console.debug('update check failed:', err);
    }
  }, []);

  useEffect(() => {
    if (!isTauriApp()) return;
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [check]);

  if (!update || dismissed) return null;

  return (
    <div className="mb-4 rounded-xl border border-cyan-500/50 bg-cyan-950/40 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-mono text-slate-200">
      <div>
        <b className="text-cyan-300">Nova versão {update.version} disponível</b> (você usa {update.currentVersion}).
        {!update.installable && ' Esta instalação não se atualiza sozinha: baixe a nova versão na página de releases.'}
        {error && <span className="block text-red-300 mt-1">{error}</span>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {update.installable ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await installUpdate(); // restarts the app on success
              } catch (err: any) {
                setError(err?.message || String(err));
                setBusy(false);
              }
            }}
            className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-black font-semibold flex items-center gap-1.5 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>{busy ? 'Baixando e instalando...' : 'Atualizar e reiniciar'}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              openReleasesPage().catch((err) => setError(String(err)));
            }}
            className="px-3 py-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-200"
          >
            Abrir página de releases
          </button>
        )}
        {!busy && (
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
            }}
            className="p-1.5 rounded text-slate-400 hover:text-slate-100"
            title="Dispensar até a próxima verificação"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
