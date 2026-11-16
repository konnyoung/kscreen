# kScreen para Windows e Linux (app desktop)

App Electron do Kennyy ScreenShare. Ele **abre o próprio site** (`https://screen.kennyy.com.br`)
numa janela nativa. Por isso interface, salas, P2P, TURN e login com Discord são exatamente os do
site: qualquer atualização do site já vale no app, sem gerar um instalador novo.

O que o app faz a mais que o navegador:

| | Navegador | App |
|---|---|---|
| Escolher tela/janela | seletor do navegador | seletor próprio (Aplicativos / Tela Inteira) com o modo de transmissão na engrenagem |
| Som do PC | só tela inteira/aba, marcando "compartilhar áudio" | todo o som do PC, com um botão |
| Eco das vozes | o som do sistema inclui as vozes da sala | o app **exclui o próprio som** |
| Excluir apps do áudio | — | ex.: não transmitir o Discord |
| Janela minimizada/coberta por jogo | o navegador reduz o ritmo da página | captura e codificação continuam a todo vapor |
| Links `kscreen://room/CODIGO` | — | abrem a sala direto no app |

## Windows x Linux

| | Windows | Linux |
|---|---|---|
| Seletor | próprio, com prévias | X11: próprio, com prévias · Wayland: o do sistema (GNOME/KDE), depois das configurações do kScreen |
| Captura de vídeo | tela inteira pela GPU (DXGI); janelas pelo GDI; jogos em tela cheia pelo monitor | PipeWire (Wayland) ou X11 |
| Som do PC sem eco e excluir apps | `kscreen-audio.exe` (process loopback, Windows 10 2004+) | PipeWire (`pw-dump`, `pw-link`, `pactl`, `parec`) |
| Vídeo pela GPU (H.264) | Media Foundation (AMD, NVIDIA, Intel) | VA-API (AMD/Intel com Mesa; NVIDIA geralmente cai para a CPU) |

O código específico de cada sistema fica em `src/platform/win.js` e `src/platform/linux.js`; o resto é
comum.

### Jogos em tela cheia (Windows)

O Chromium captura janelas pelo GDI, copiando pela CPU (o WGC só existe como plano B no Windows 11).
Quando a janela escolhida ocupa o monitor inteiro, o app captura o monitor pelo DXGI, na GPU, e
envia tela preta enquanto o jogo não está em primeiro plano (Alt+Tab, área de trabalho).

### Som do PC no Linux

O app cria uma saída de áudio virtual chamada "kScreen" (com prioridade mínima, nunca vira a saída
padrão) e liga nela o som de cada app, menos o kScreen e os excluídos. Os apps continuam tocando
normalmente nos seus fones. Precisa do PipeWire, que é o padrão no Ubuntu 22.10+, Fedora 34+ e Arch,
e dos utilitários `pactl`/`parec`:

| Distro | Pacotes |
|---|---|
| Ubuntu/Debian | `pipewire-bin pipewire-pulse pulseaudio-utils` (o `.deb` já recomenda) |
| Fedora | `pipewire-utils pulseaudio-utils` |
| Arch | `pipewire pipewire-pulse libpulse` |

Sem eles o app funciona normalmente, só sem o som do PC.

## Login com Discord

O Discord **nunca abre dentro do app**. Ao clicar em "Entrar com Discord":

1. o app abre o Discord no **navegador padrão** e mostra "Continue no navegador";
2. você clica em **Autorizar** no navegador;
3. o site manda o navegador para `http://127.0.0.1:<porta>/kscreen-auth`, um servidorzinho
   temporário do próprio app, com um código de uso único (vale 2 minutos);
4. o app troca esse código pela sessão. A troca exige um segredo (PKCE) que nunca sai do app.

Esse fluxo depende das rotas do site (`/api/auth/desktop/redeem` no `vite.config.js`): publique o
site antes de distribuir o app.

## Desenvolvimento

```bash
cd desktop
npm install
npm run build:audio
npm start
```

`npm run build:audio` só faz algo no Windows. `npm start` abre o site de produção; `npm run dev`
usa o site local (`npm run dev` na raiz, porta 5173). Também dá para escolher o servidor com
`--server=https://outro.endereco` ou com a variável `KSCREEN_URL`.

Atalhos: **F5** recarrega, **F11** tela cheia, **F12** DevTools, **Ctrl + / Ctrl -** zoom.

## Gerar os instaladores

Suba a `version` no `package.json` antes de cada versão nova.

**Windows** (no Windows):

```bash
npm run dist
```

Sai `release/kScreen-Setup-<versão>.exe`: instalador em português, com escolha da pasta e atalhos.
Sem certificado de assinatura, o SmartScreen avisa na primeira execução (**Mais informações →
Executar assim mesmo**).

**Linux** (de qualquer sistema, com Docker):

```bash
npm run dist:linux:docker
```

Ou direto numa máquina Linux (o `.rpm` precisa do `rpmbuild` e o `.pacman` do `bsdtar`):

```bash
npm run dist:linux
```

Saem:

| Arquivo | Distros | Instalar |
|---|---|---|
| `kscreen-<versão>-amd64.deb` | Ubuntu, Debian, Mint, Pop!_OS | `sudo apt install ./kscreen-<versão>-amd64.deb` |
| `kscreen-<versão>-x86_64.rpm` | Fedora, openSUSE, RHEL | `sudo dnf install ./kscreen-<versão>-x86_64.rpm` |
| `kscreen-<versão>-x64.pacman` | Arch, Manjaro, EndeavourOS | `sudo pacman -U kscreen-<versão>-x64.pacman` |

O app aparece no menu como **kScreen** e o comando no terminal é `kscreen`.

## Arquivos

| Arquivo | O que é |
|---|---|
| `src/main.js` | Janela, seletor, permissões, login pelo navegador, áudio (parte comum) |
| `src/platform/win.js` | Windows: helper nativo, jogos em tela cheia pelo monitor |
| `src/platform/linux.js` | Linux: áudio pelo PipeWire, seletor do sistema no Wayland, VA-API |
| `src/preload.js` | Ponte `window.kscreenDesktop` que o site usa para saber que está no app |
| `src/picker.*` | Seletor de telas e janelas |
| `src/login-wait.*`, `src/offline.*` | Telas de "continue no navegador" e "sem conexão" |
| `src/titlebar.*` | Barra de título própria (a janela não usa a moldura do sistema) |
| `native/kscreen-audio.cs` | Helper do Windows: som sem o próprio app, lista de apps, janelas |
| `scripts/dist-linux-docker.js` | Gera os pacotes Linux num contêiner |
| `scripts/make-icon.js` | Gera os ícones e a arte lateral do instalador |
