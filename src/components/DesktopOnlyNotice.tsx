import React from 'react';
import { MonitorSmartphone } from 'lucide-react';

/** Shown when the UI is opened in a plain browser: every measurement runs in the desktop (Tauri) backend. */
export const DesktopOnlyNotice: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center p-6 bg-[#050b10] text-slate-200 font-mono">
    <div className="max-w-md rounded-xl border border-cyan-900/50 bg-[#06111a] p-6 space-y-3 text-sm">
      <div className="flex items-center gap-2 text-cyan-300 font-bold">
        <MonitorSmartphone className="w-5 h-5" />
        <span>xCloud Cyber-Monitor é um aplicativo desktop</span>
      </div>
      <p className="text-slate-400 leading-relaxed">
        As medições (ping, rota, bufferbloat), o histórico e o cofre de chaves rodam no backend nativo, que não existe em um navegador comum.
      </p>
      <p className="text-slate-400 leading-relaxed">
        Para desenvolver: <code className="text-cyan-300">npm run tauri:dev</code>. Para usar: instale o aplicativo.
      </p>
    </div>
  </div>
);
