# xCloud Cyber-Monitor Brasil

Aplicativo desktop (Tauri) que mede a qualidade da sua conexão para jogar no **Xbox Cloud Gaming (xCloud)** no Brasil e
**mostra onde o problema está**: na sua rede local, no acesso da operadora, no núcleo dela ou no caminho até a Microsoft.
Guarda o histórico só no seu computador e gera um **relatório de evidência** para abrir chamado na operadora.

## O que ele mede

- **Latência, jitter e perda** a cada 30 s, em segundo plano, até três pontos do mesmo caminho ao mesmo tempo:
  seu **roteador**, o **1º salto da operadora** (descoberto pelo traceroute) e o **servidor de entrada do xCloud**, mais
  alvos de borda (IX.br, Equinix) e de referência nos EUA. Alvo que não responde aparece como sem resposta, nunca com valor inventado.
- **Rota real** (`traceroute`/`tracepath`/`tracert`) e **desvio internacional (BGP hairpinning)**, detectado por nome de
  salto com código de cidade dos EUA ou por salto de latência sustentado (picos isolados de ICMP são descartados).
- **Bufferbloat de verdade:** satura o download e depois o upload enquanto mede a latência (nota A+ a F, vazão, latência do
  roteador sob carga). Pede confirmação: usa até ~330 MB e conecta à Cloudflare.
- **Fila do xCloud** do jogo que você abriu, usando a sessão do xStreaming instalado (somente leitura do token local).
- **Copiloto de IA (opcional)**, com a sua chave da OpenAI guardada no cofre do sistema.

## O que ele conclui

Um motor determinístico (sem IA) analisa o histórico: horários de pico, episódios de degradação (3 min ou mais), perda,
jitter, bufferbloat, desvio de rota, e **onde cada episódio começou** comparando roteador × 1º salto × xCloud. Se o roteador
fica estável enquanto o resto degrada, o relatório mostra isso. A conclusão "sua rede local está limpa" só aparece com 24 h
de dados do roteador. Em **Histórico** há gráficos, achados e o botão **Relatório para o ISP** (HTML autocontido, imprime em PDF).

## Privacidade: o que fica e o que sai da máquina

| Dado | Onde fica |
|---|---|
| Medições (SQLite) | `br.com.xcloud.cybermonitor/history.sqlite` na pasta de dados do app (Linux `~/.local/share`, macOS `~/Library/Application Support`, Windows `%APPDATA%`). Amostras brutas por 14 dias, resumos por hora por 365 dias. Dá para pausar a coleta, exportar CSV e apagar tudo em Configurações. |
| Chave da OpenAI | Cofre do sistema (Secret Service / Keychain / Credential Manager), nunca em arquivo. |
| Token do xStreaming | Lido do arquivo local do xStreaming e enviado só aos endereços da Microsoft. |

Sai da máquina: sondagens ICMP/TCP aos alvos; **Cloudflare** só durante o teste de bufferbloat, que você confirma; **OpenAI**
só quando você usa o chat (sua mensagem e as métricas atuais); **GitHub** na verificação de atualizações.

## Usando

Instaladores para Windows, Linux e macOS ficam nas *Releases*. O app tem bandeja do sistema: fechar a janela continua
coletando (desligável), e há opção de iniciar com o sistema. Atualizações são baixadas só se a assinatura conferir.

## Desenvolvendo

Requisitos: Node 22, Rust estável e, no Linux, `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libdbus-1-dev
libayatana-appindicator3-dev librsvg2-dev build-essential`.

```
npm ci
npm run tauri:dev        # abre a janela (o front sobe via vite em :3030)
npm test                 # testes do front (tsx)
cd src-tauri && cargo test --lib
npm run lint             # tsc --noEmit
```

Abrir `http://localhost:3030` num navegador comum só mostra um aviso: as medições rodam no backend Rust.
Testes que usam a rede ou o seu token local são opt-in: `npm run test:live`, `cargo test live_ -- --ignored --nocapture`.

### Arquitetura

Front (React 19, Vite, Tailwind 4, SVG puro) ⟷ comandos Tauri ⟷ backend Rust em `src-tauri/src`:

| Módulo | Função |
|---|---|
| `network` | sondas ICMP/TCP dos alvos |
| `route` | traceroute real, análise de desvio, gateway e 1º salto |
| `history` | SQLite, coletor de 30 s, séries para os gráficos |
| `analysis` | motor determinístico: picos, episódios, causa |
| `report` | relatório de evidência em HTML |
| `bufferbloat` | teste com saturação real |
| `xcloud`, `ai` | fila do xCloud e copiloto |
| `desktop`, `updater` | bandeja, instância única, autostart, atualização assinada |

Um teste de contrato garante que todo comando chamado pelo front existe no Rust com os mesmos nomes de argumento.
O mapa usa os contornos do Natural Earth (domínio público).

## Limites que valem saber

- **ICMP não é tráfego de jogo.** A operadora pode alegar prioridade diferente; confirme os números com uma ferramenta
  independente (NIC.br, Measurement Lab).
- O servidor da sessão de jogo muda a cada partida e só é visível com captura de pacotes; os alvos fixos são a base comparável.
- Vários alvos de referência bloqueiam ICMP e TCP e aparecem sem resposta.
- No Linux, só o AppImage se atualiza sozinho. Os instaladores de Windows e macOS ainda não têm assinatura de código do
  sistema (veja `docs/RELEASE.md`).

Publicação de versões: [`docs/RELEASE.md`](docs/RELEASE.md).

## Licença

[MIT](LICENSE). Os contornos do mapa são do Natural Earth (domínio público).
