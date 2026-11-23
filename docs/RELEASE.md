# Publicando uma versão

## O que existe

- **Auto-update assinado.** O app consulta
  `https://github.com/timeuz/xcloud-monitor/releases/latest/download/latest.json`, baixa o pacote e **só instala se a
  assinatura bater com a chave pública** gravada em `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
- **Chave de assinatura (minisign).** A chave **privada** está em `~/.tauri/xcloud-monitor.key` na máquina onde o projeto
  foi configurado e **nunca vai para o repositório**. Sem ela não dá para publicar atualizações que os apps instalados
  aceitem. **Faça backup** (gerenciador de senhas, por exemplo). Perdeu a chave = os apps já instalados não aceitam mais
  updates e precisam ser reinstalados à mão com uma nova chave pública.
- **Verificação de versão.** `npm run check:version` falha se `package.json`, `src-tauri/Cargo.toml` e
  `src-tauri/tauri.conf.json` tiverem versões diferentes, ou se a tag não for `v<versão>`. Roda na CI e no release.

## Configuração única (GitHub)

Em *Settings > Secrets and variables > Actions*, crie:

| Secret | Valor |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | conteúdo do arquivo `~/.tauri/xcloud-monitor.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | senha da chave (deixe vazio se a chave foi gerada sem senha) |

Pela linha de comando (a chave é enviada ao GitHub, confirme que é isso que você quer):

```
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/xcloud-monitor.key
```

Para trocar a chave (por exemplo, para usar uma senha): `npx tauri signer generate -w ~/.tauri/xcloud-monitor.key -f`,
copie o conteúdo de `~/.tauri/xcloud-monitor.key.pub` para `plugins.updater.pubkey` e atualize os secrets.
Versões já instaladas com a chave antiga **não** aceitarão updates da nova.

## Publicar

1. Atualize a versão nos **três** arquivos: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. Rode `npm run check:version` e `npm test`.
3. Faça merge na `main`, crie a tag e envie: `git tag v1.1.0 && git push origin v1.1.0`.
4. O workflow *Release* compila Windows, macOS (Intel e Apple Silicon) e Linux, assina os pacotes de atualização e
   publica o release com o `latest.json`. Os apps instalados veem a nova versão em até 6 horas.

## Build local

`npm run tauri:build` exige `TAURI_SIGNING_PRIVATE_KEY` (porque gera pacotes de atualização). Para um build local sem
isso: `npm run tauri:build:local`.

## Limites que você precisa conhecer

- **O updater precisa que o `latest.json` e os instaladores sejam baixáveis sem login.** Este repositório é público, então
  `https://github.com/timeuz/xcloud-monitor/releases/latest/download/latest.json` funciona sem token. Se um dia o
  repositório voltar a ser privado, o app instalado passa a mostrar "Nenhuma atualização publicada". Não embuta token no app.
- **Linux:** só o **AppImage** se atualiza sozinho. Instalações `.deb`/`.rpm` mostram o aviso de nova versão e abrem a
  página de releases.
- **Assinatura de código do sistema (Windows e macOS) NÃO está configurada.** A assinatura acima garante a integridade
  das *atualizações*, mas o primeiro instalador baixado ainda gera aviso do Windows SmartScreen e do Gatekeeper do
  macOS ("desenvolvedor não identificado"). Resolver isso exige certificados pagos:
  - **Windows:** certificado de assinatura de código (OV/EV) ou Azure Trusted Signing.
  - **macOS:** conta Apple Developer (US$ 99/ano), certificado *Developer ID Application* e notarização.
  Depois de obtê-los, configure os secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` e a assinatura do Windows conforme a documentação do Tauri; o
  `tauri-action` os aproveita. Não habilitei isso no workflow porque variáveis vazias quebram o build.
- O fluxo de update nunca foi exercitado ponta a ponta antes do primeiro release: publique uma versão de teste
  (por exemplo `v1.0.1`), instale a anterior e confirme que o aviso aparece e a instalação funciona.
