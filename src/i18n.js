// kScreen language: the system language unless Settings > Idioma pins one:
// pt / pt-BR / pt-PT -> Portuguese (the text written in the code), anything else -> English.
//
// The UI keeps writing Portuguese; when the language is English, a MutationObserver swaps any
// text or attribute (title, aria-label, placeholder, alt) found in the dictionary below before
// the browser paints. Keys with {placeholders} match messages built with values in them
// ("Você entrou na sala abc-def-ghi."), and the values are translated too when they are
// dictionary words themselves ("Fonte" inside "Ao vivo em Fonte a 60 FPS").

export function systemLang() {
  const list = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  return String(list[0] || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

// Settings > Idioma can pin a language ('pt' | 'en'); 'auto' follows the system. Takes effect
// on the next load (the observer below translates once and keeps going).
const LANG_KEY = 'kscreen.lang';
export function langChoice() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'pt' || v === 'en' ? v : 'auto';
  } catch { return 'auto'; }
}
export function setLangChoice(value) {
  try {
    if (value === 'pt' || value === 'en') localStorage.setItem(LANG_KEY, value);
    else localStorage.removeItem(LANG_KEY);
  } catch { /* storage blocked */ }
}
export const effectiveLang = (choice) => (choice === 'pt' || choice === 'en' ? choice : systemLang());

export const lang = effectiveLang(langChoice());

const EN = {
  // --- Login / home ---
  'Faça login para continuar': 'Sign in to continue',
  'Entrar com Discord': 'Sign in with Discord',
  'Ao entrar você concorda com os': 'By signing in you agree to the',
  'Termos de Uso': 'Terms of Use',
  'Links sociais': 'Social links',
  'Melhor bot de música': 'Best music bot',
  'Código-fonte': 'Source code',
  'Criar sala': 'Create room',
  'Entrar em uma sala': 'Join a room',
  'Código da sala': 'Room code',
  'Avatar do Usuário': 'User avatar',
  'Sair da conta': 'Sign out',
  'Usuário': 'User',
  'Login com Discord não configurado no servidor (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET).': 'Discord sign-in is not set up on the server (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET).',
  'O endereço deste site não está nos Redirects do app no Discord Developer Portal.': 'This site’s address is not in the app’s Redirects on the Discord Developer Portal.',
  'O login expirou ou foi aberto em outra aba. Tente novamente.': 'The sign-in expired or was opened in another tab. Try again.',
  'Login cancelado.': 'Sign-in cancelled.',
  'Falha ao falar com o Discord. Tente novamente.': 'Couldn’t reach Discord. Try again.',
  'Não foi possível entrar com o Discord.': 'Couldn’t sign in with Discord.',
  'Sua sessão expirou. Entre com o Discord de novo.': 'Your session expired. Sign in with Discord again.',
  'Você saiu da conta.': 'You signed out.',

  // --- Room chat ---
  'Chat da sala': 'Room chat',
  'Enviar': 'Send',
  'Volume da transmissão de {name}': '{name}’s stream volume',
  'Volume de {name}': '{name}’s volume',
  'Fechar chat': 'Close chat',
  'Novas mensagens': 'New messages',
  'Cancelar resposta': 'Cancel reply',
  'Enviar imagem': 'Upload image',
  'Emojis e GIFs': 'Emojis and GIFs',
  'Solte para enviar': 'Drop to upload',
  'PNG, JPG, GIF ou WebP até 8 MB': 'PNG, JPG, GIF or WebP up to 8 MB',
  'Abrir no navegador': 'Open in browser',
  'Salvar imagem': 'Save image',
  'Imagem removida para liberar espaço na sala.': 'Image removed to free up space in the room.',
  '{n} imagens removidas para liberar espaço na sala.': '{n} images removed to free up space in the room.',
  'Arraste para ajustar a largura': 'Drag to resize',
  'Conversar em {room}': 'Message {room}',
  'Ontem às {time}': 'Yesterday at {time}',
  'Boas-vindas ao chat da sala!': 'Welcome to the room chat!',
  'As mensagens ficam aqui enquanto a sala existir. Quando todos saírem, o chat é apagado.': 'Messages stay here while the room exists. When everyone leaves, the chat is erased.',
  'usuário-desconhecido': 'unknown-user',
  'Clique para ver o anexo': 'Click to see attachment',
  'Mensagem original apagada': 'Original message was deleted',
  '(editado)': '(edited)',
  'Não foi possível enviar.': 'Couldn’t send.',
  'Tentar de novo': 'Retry',
  'Descartar': 'Discard',
  'Adicionar reação': 'Add reaction',
  'Responder': 'Reply',
  'Editar': 'Edit',
  'Copiar texto': 'Copy text',
  'Apagar mensagem': 'Delete message',
  'Esc para': 'escape to',
  'cancelar': 'cancel',
  'Enter para': 'enter to',
  'salvar': 'save',
  '{name} está digitando...': '{name} is typing...',
  '{a} e {b} estão digitando...': '{a} and {b} are typing...',
  'Várias pessoas estão digitando...': 'Several people are typing...',
  'Respondendo a': 'Replying to',
  'Você não está em uma sala.': 'You are not in a room.',
  'Falha ao enviar a imagem.': 'Image upload failed.',
  'Remover': 'Remove',
  'Resultados de opções para @{q}': 'Options matching @{q}',
  'Notifica todos que estão nesta sala.': 'Notifies everyone in this room.',
  'Emojis que combinam com :{q}': 'Emojis matching :{q}',
  'Pesquisar no GIPHY': 'Search GIPHY',
  'Encontre o emoji perfeito': 'Find the perfect emoji',
  'Carregando...': 'Loading...',
  'Nenhum GIF encontrado.': 'No GIFs found.',
  'Nenhum emoji encontrado.': 'No emojis found.',
  'Não foi possível carregar os emojis.': 'Couldn’t load emojis.',
  'Busca de GIFs não configurada (GIPHY_API_KEY).': 'GIF search is not set up (GIPHY_API_KEY).',
  'Não foi possível buscar GIFs agora.': 'Couldn’t search GIFs right now.',
  'Você ainda pode colar o link de um GIF ou enviar um arquivo .gif.': 'You can still paste a GIF link or upload a .gif file.',
  'Usados recentemente': 'Frequently used',
  'Carinhas e emoções': 'Smileys & emotion',
  'Pessoas': 'People',
  'Animais e natureza': 'Animals & nature',
  'Comidas e bebidas': 'Food & drink',
  'Viagens e lugares': 'Travel & places',
  'Atividades': 'Activities',
  'Objetos': 'Objects',
  'Símbolos': 'Symbols',
  'Bandeiras': 'Flags',
  'Texto copiado.': 'Text copied.',
  'Opções da imagem': 'Image options',
  'Copiar imagem': 'Copy image',
  'Copiar link': 'Copy link',
  'Link copiado.': 'Link copied.',
  'Imagem copiada.': 'Image copied.',
  'Não foi possível copiar a imagem.': 'Could not copy the image.',
  'Não foi possível salvar a imagem.': 'Could not save the image.',
  'Seu navegador não permite copiar imagens.': 'Your browser can’t copy images.',
  'A mensagem original não está carregada.': 'The original message isn’t loaded.',
  'Apagar': 'Delete',
  'Tem certeza de que deseja apagar esta mensagem? (Segure Shift ao clicar para pular esta confirmação.)': 'Are you sure you want to delete this message? (Hold Shift when clicking to skip this.)',
  'Envie imagens PNG, JPG, GIF ou WebP.': 'Upload PNG, JPG, GIF or WebP images.',
  'Calma! Você está enviando mensagens rápido demais.': 'Slow down! You are sending messages too fast.',

  // --- Room modals ---
  'Nova sala': 'New room',
  'Senha (opcional)': 'Password (optional)',
  'Código personalizado (opcional)': 'Custom code (optional)',
  'De 4 a 20 letras ou números. Em branco, o código é gerado.': '4 to 20 letters or numbers. Leave it blank for a generated code.',
  'noitedejogos': 'gamenight',
  'Salas recentes': 'Recent rooms',
  'Código gerado': 'Generated code',
  'Fixar': 'Pin',
  'Desafixar': 'Unpin',
  'Fixada': 'Pinned',
  'Até 3 salas fixadas': 'Up to 3 pinned rooms',
  'Limite': 'Limit',
  '2 pessoas': '2 people',
  '5 pessoas': '5 people',
  '10 pessoas': '10 people',
  'ilimitado': 'unlimited',
  'Cancelar': 'Cancel',
  'Criando...': 'Creating...',
  'Sala com senha': 'Password-protected room',
  'Senha de': 'Password for',
  'Entrar': 'Join',
  'Sair da chamada?': 'Leave the call?',
  'Você será desconectado e voltará para a tela inicial.': 'You’ll be disconnected and taken back to the home screen.',
  'Sair': 'Leave',
  'Sala {code} criada.': 'Room {code} created.',
  'Não foi possível criar a sala. Verifique a conexão.': 'Couldn’t create the room. Check your connection.',
  'Não foi possível entrar na sala.': 'Couldn’t join the room.',
  'Não foi possível entrar na sala do link.': 'Couldn’t join the room from the link.',
  'Digite o código completo da sala (xxx-xxx-xxx).': 'Type the full room code (xxx-xxx-xxx).',
  'Digite o código da sala.': 'Type the room code.',
  'Código inválido.': 'Invalid code.',
  'O código do link é inválido.': 'The link’s room code is invalid.',
  'O código deve ter de 4 a 20 letras ou números.': 'The code must have 4 to 20 letters or numbers.',
  'Esse código já está em uso.': 'That code is already in use.',
  'Você entrou na sala {code}.': 'You joined room {code}.',
  'Você saiu da sala.': 'You left the room.',
  // Server messages shown as they come
  'Entre com o Discord para continuar.': 'Sign in with Discord to continue.',
  'A senha pode ter no máximo {n} caracteres.': 'The password can have at most {n} characters.',
  'Muitas tentativas. Tente de novo em um minuto.': 'Too many attempts. Try again in a minute.',
  'Esta sala tem senha.': 'This room has a password.',
  'Senha incorreta.': 'Wrong password.',
  'A sala está cheia ({n} pessoas).': 'The room is full ({n} people).',

  // --- Top bar / stage ---
  'Copiar código da sala': 'Copy room code',
  'Convidar para a sala': 'Invite to the room',
  'AO VIVO': 'LIVE',
  'Alternar entre grade e destaque': 'Switch between grid and focus',
  'Grade': 'Grid',
  'Destaque': 'Focus',
  'Detalhes da conexão P2P': 'P2P connection details',
  'Desconectado': 'Disconnected',
  'P2P conectado': 'P2P connected',
  'Conectando...': 'Connecting...',
  'Aguardando amigos': 'Waiting for friends',
  'Aguardando transmissão...': 'Waiting for a stream...',
  'Tela cheia': 'Fullscreen',
  'Sair da tela cheia': 'Exit fullscreen',
  'Tela de {name}': '{name}’s screen',
  '{n} telas ao vivo': '{n} live screens',
  '{n} na sala': '{n} in the room',
  '{name} (Você)': '{name} (You)',
  '{name} (Você) · clique direito para volume e opções': '{name} (You) · right-click for volume and options',
  '{name} · clique direito para volume e opções': '{name} · right-click for volume and options',
  '{name}, transmitindo': '{name}, streaming',
  '{name} (Você), transmitindo': '{name} (You), streaming',
  '{name} · transmitindo': '{name} · streaming',
  'conectando': 'connecting',
  'reconectando': 'reconnecting',
  'Microfone desligado': 'Microphone off',
  'Áudio desligado': 'Deafened',
  'Assistir transmissão': 'Watch stream',
  'Assistindo: {names}': 'Watching: {names}',
  '🔊 Clique para ativar o áudio da sala': '🔊 Click to turn on room audio',

  // --- Dock ---
  'Controles da chamada': 'Call controls',
  'Microfone': 'Microphone',
  'Ativar microfone': 'Unmute microphone',
  'Silenciar microfone': 'Mute microphone',
  'Microfone silenciado': 'Microphone muted',
  'Microfone ativado': 'Microphone on',
  'Permissão do microfone negada.': 'Microphone permission denied.',
  'Não foi possível usar o microfone.': 'Couldn’t use the microphone.',
  'Opções de voz': 'Voice options',
  'Opções de vídeo': 'Video options',
  'Câmera': 'Camera',
  'Ligar câmera': 'Turn on camera',
  'Desligar câmera': 'Turn off camera',
  'Permissão da câmera negada.': 'Camera permission denied.',
  'Nenhuma câmera encontrada.': 'No camera found.',
  'A câmera está em uso por outro programa.': 'The camera is being used by another program.',
  'Não foi possível ligar a câmera.': 'Couldn’t turn on the camera.',
  'Compartilhar tela': 'Share screen',
  'Opções da transmissão': 'Stream options',
  'Áudio da sala': 'Room audio',
  'Silenciar áudio da sala': 'Deafen',
  'Ativar áudio da sala': 'Undeafen',
  'Áudio da sala silenciado': 'Deafened',
  'Áudio da sala ativado': 'Undeafened',
  'Copiar link da sala': 'Copy room link',
  'Sair da sala': 'Leave room',
  'Entre na minha sala: {code}': 'Join my room: {code}',
  'Link da sala copiado ({code}).': 'Room link copied ({code}).',
  'Código copiado: {code}': 'Code copied: {code}',
  'Copie:': 'Copy:',

  // --- Voice / video device menu ---
  'Dispositivo de entrada': 'Input device',
  'Dispositivo de saída': 'Output device',
  'Volume de entrada': 'Input volume',
  'Volume de saída': 'Output volume',
  'Supressão de ruído': 'Noise suppression',
  'Intensidade': 'Strength',
  'Intensidade em porcentagem': 'Strength in percent',
  'Cancelamento de eco': 'Echo cancellation',
  'Não foi possível aplicar no microfone.': 'Couldn’t apply that to the microphone.',
  '{label} em porcentagem': '{label} in percent',
  'Padrão do sistema': 'System default',
  'Alto-falantes': 'Speakers',
  'Nenhum encontrado': 'None found',
  'Não foi possível usar esse dispositivo de saída.': 'Couldn’t use that output device.',
  'Não foi possível usar essa câmera.': 'Couldn’t use that camera.',
  'Não foi possível usar esse microfone.': 'Couldn’t use that microphone.',

  // --- Live menu / streaming ---
  'Transmissão': 'Stream',
  'Parar de transmitir': 'Stop streaming',
  'Alterar a transmissão': 'Change stream',
  'Qualidade da transmissão': 'Stream quality',
  'Taxa de quadros': 'Frame rate',
  'Resolução': 'Resolution',
  'Áudio (estéreo)': 'Audio (stereo)',
  'Compartilhar áudio da transmissão': 'Share stream audio',
  'Fonte': 'Source',
  'Alta': 'High',
  'Máxima': 'Max',
  'Alta · {rate}': 'High · {rate}',
  'Máxima · {rate}': 'Max · {rate}',
  'Esta transmissão não tem áudio': 'This stream has no audio',
  'Pausado: o jogo não está em primeiro plano': 'Paused: the game is not in the foreground',
  'Ao vivo em {res} a {fps} FPS, com áudio.': 'Live at {res}, {fps} FPS, with audio.',
  'Ao vivo sem som. O som do PC fica na engrenagem do seletor.': 'Live without sound. PC audio is in the picker’s gear menu.',
  'Compartilhando SEM áudio: o Firefox não captura o som da tela. Use o Chrome ou Edge para transmitir com som.': 'Sharing WITHOUT audio: Firefox doesn’t capture screen audio. Use Chrome or Edge to stream with sound.',
  'Compartilhando SEM áudio. Para ter som, escolha uma aba ou a tela inteira e marque "Compartilhar áudio" (janelas não têm som).': 'Sharing WITHOUT audio. For sound, pick a tab or the entire screen and tick "Share audio" (windows have no sound).',
  'Compartilhamento de tela encerrado.': 'Screen sharing ended.',
  'Não foi possível iniciar a captura de tela.': 'Couldn’t start screen capture.',
  'O iPhone e o iPad não deixam nenhum navegador compartilhar a tela (é uma limitação da Apple). Você ainda pode ligar a câmera, ou transmitir de um computador.': 'iPhone and iPad don’t let any browser share the screen (an Apple limitation). You can still turn on your camera, or stream from a computer.',
  'Os navegadores do Android não deixam sites compartilhar a tela, nem o Chrome mais novo. Você ainda pode ligar a câmera, ou transmitir de um computador.': 'Android browsers don’t let websites share the screen, not even the latest Chrome. You can still turn on your camera, or stream from a computer.',
  'Este navegador não permite compartilhar a tela. Use o Chrome, Edge ou Firefox atualizado.': 'This browser can’t share the screen. Use an up-to-date Chrome, Edge or Firefox.',
  'Não dá para compartilhar a tela aqui': 'Can’t share the screen here',
  'O compartilhamento de tela exige HTTPS.': 'Screen sharing requires HTTPS.',
  'Áudio da transmissão em {rate}, estéreo.': 'Stream audio at {rate}, stereo.',
  'Transmitindo em {res} a {fps} FPS.': 'Streaming at {res}, {fps} FPS.',
  'Não foi possível aplicar essa qualidade.': 'Couldn’t apply that quality.',
  'Transmissão alterada.': 'Stream changed.',
  'Não foi possível trocar a transmissão.': 'Couldn’t change the stream.',
  'Áudio da transmissão ativado.': 'Stream audio on.',
  'Áudio da transmissão silenciado.': 'Stream audio muted.',

  // --- Right-click menu ---
  'Opções do participante': 'Participant options',
  'Volume do usuário': 'User volume',
  'Volume da transmissão': 'Stream volume',
  'Silenciar': 'Mute',
  'Ativar som': 'Unmute',
  'Desativar vídeo': 'Disable video',
  'Parar de assistir': 'Stop watching',
  'Mostrar participantes sem vídeo': 'Show participants without video',

  // --- Status panel (static parts) ---
  'Servidor, salas, TURN e as rotas WebRTC desta sala.': 'Server, rooms, TURN and this room’s WebRTC routes.',
  'Fechar': 'Close',
  'Tipo de Conexão': 'Connection type',
  'Aguardando participantes...': 'Waiting for participants...',
  'Menor ping': 'Lowest ping',
  'Protocolo': 'Protocol',
  'Servidor': 'Server',
  'Salas com gente': 'Rooms with people',
  'Pessoas no kScreen': 'People on kScreen',
  'Pessoas no TURN': 'People on TURN',
  'Relays TURN': 'TURN relays',
  'Participantes': 'Participants',
  'Nenhum outro participante conectado ainda.': 'No other participant connected yet.',
  'Renovar rotas (ICE restart)': 'Renew routes (ICE restart)',
  'Abrir 2ª aba de teste': 'Open 2nd test tab',
  'Registro de eventos': 'Event log',
  'Conectado': 'Connected',
  'Conectando': 'Connecting',
  'Reconectando': 'Reconnecting',

  // --- Profiles, local indicators, chat code blocks ---
  'Abrir perfil': 'Open profile',
  'Abrir em outra janela': 'Open in another window',
  'Trazer de volta': 'Bring back',
  'Aberta em outra janela': 'Open in another window',
  'Transmissão encerrada': 'Stream ended',
  'O navegador bloqueou a janela. Permita pop-ups para este site.': 'The browser blocked the window. Allow pop-ups for this site.',
  'Desfazer alteração': 'Undo change',
  'Opções de saída': 'Output options',
  'Usar a cor automática': 'Use the automatic colour',
  'Não se esqueça de salvar suas alterações!': "Don't forget to save your changes!",
  'Perfil de {name}': '{name}’s profile',
  'Editar perfil': 'Edit profile',
  'Na chamada': 'In the call',
  'No computador (app)': 'On the computer (app)',
  'No navegador': 'In the browser',
  'No celular': 'On the phone',
  'transmitindo': 'streaming',
  'áudio desligado': 'audio off',
  'microfone desligado': 'mic off',
  '(Você)': '(You)',
  'Admin': 'Admin',
  'Você silenciou esta pessoa': 'You muted this person',
  'Você silenciou esta transmissão': 'You muted this stream',
  'Você desativou o vídeo desta pessoa': 'You turned off this person’s video',
  'Copiar': 'Copy',
  'Copiado!': 'Copied!',
  'Copiar código': 'Copy code',
  'Não foi possível copiar.': 'Could not copy.',

  // --- Settings window ---
  'Configurações': 'Settings',
  'Configurações (Ctrl+,)': 'Settings (Ctrl+,)',
  'Configurações de voz': 'Voice settings',
  'Configurações de vídeo': 'Video settings',
  'Configurações da transmissão': 'Stream settings',
  'Buscar': 'Search',
  'Buscar configurações': 'Search settings',
  'Seções': 'Sections',
  'Fechar configurações': 'Close settings',
  'Voltar': 'Back',
  'Resultados': 'Results',
  'Nada encontrado para “{q}”.': 'Nothing found for “{q}”.',
  'Configurações do app': 'App settings',
  'Minha conta': 'My account',
  'Voz e vídeo': 'Voice & video',
  'Sons': 'Sounds',
  'Chamada': 'Call',
  'Idioma': 'Language',
  'Atalhos': 'Shortcuts',
  'Avançado': 'Advanced',
  'Ver perfil': 'View profile',
  'Convidado': 'Guest',
  'Nome de exibição': 'Display name',
  'Nome de usuário': 'Username',
  'Cor do perfil': 'Profile color',
  'Automática': 'Automatic',
  'Tipo de conta': 'Account type',
  'Convidado': 'Guest',
  'Dica: Você pode trocar sua foto clicando nela.': 'Tip: You can change your photo by clicking it.',
  'Nome de usuário e foto vêm do seu Discord. O nome de exibição e a cor ficam salvos neste navegador.': 'Username and photo come from your Discord. The display name and color are saved in this browser.',
  'A foto vem do seu Discord.': 'The photo comes from your Discord.',
  'Trocar foto': 'Change photo',
  'Foto inválida. Tente outra imagem.': 'Invalid photo. Try another image.',
  'Escolha um arquivo de imagem.': 'Choose an image file.',
  'A foto pode ter no máximo 5 MB.': 'The photo can be at most 5 MB.',
  'Não foi possível ler essa imagem. Tente outro formato.': "Couldn't read that image. Try another format.",
  'Salvar': 'Save',
  'Deixe vazio para usar o nome do Discord.': 'Leave it empty to use your Discord name.',
  'O nome precisa ter pelo menos 2 caracteres.': 'The name needs at least 2 characters.',
  'Não foi possível salvar. Tente de novo.': 'Could not save. Try again.',
  'Escolha um nome (mínimo 2 caracteres).': 'Pick a name (at least 2 characters).',
  'Escolher cor do perfil': 'Pick profile color',
  'Cor do perfil (hex)': 'Profile color (hex)',
  'Sessão': 'Session',
  'Desconectar': 'Sign out',
  'Você sai da chamada e volta para o login.': 'You leave the call and go back to sign-in.',
  'Volta para a tela de login.': 'Goes back to the sign-in screen.',
  'Sair da conta?': 'Sign out?',
  'Você sairá da chamada e da sua conta.': 'You’ll leave the call and sign out.',
  'Você voltará para a tela de login.': 'You’ll go back to the sign-in screen.',
  'Dispositivos': 'Devices',
  'Padrão': 'Default',
  'Nenhum microfone encontrado': 'No microphone found',
  'Nenhuma câmera encontrada': 'No camera found',
  'Mostrar nomes dos dispositivos': 'Show device names',
  'Mostrar nomes das câmeras': 'Show camera names',
  'Câmera padrão': 'Default camera',
  'Volume': 'Volume',
  'Vale para a sala toda e para os sons.': 'Applies to the whole room and to sounds.',
  'Parar teste': 'Stop testing',
  'Teste do microfone': 'Mic test',
  'Você vai se ouvir como os outros te ouvem. O áudio da sala fica mudo durante o teste.': 'You’ll hear yourself the way others hear you. Room audio is muted during the test.',
  'Você vai se ouvir como os outros te ouvem. Use fones para não dar eco.': 'You’ll hear yourself the way others hear you. Use headphones to avoid echo.',
  'Ouvindo seu microfone, com a supressão de ruído…': 'Listening to your mic, with noise suppression…',
  'Remove teclado, ventilador e barulho de fundo, e silencia as pausas entre as falas.': 'Removes keyboard, fan and background noise, and silences the pauses between words.',
  'Ouvindo seu microfone…': 'Listening to your mic…',
  'Não foi possível abrir o microfone.': 'Couldn’t open the microphone.',
  'Processamento de voz': 'Voice processing',
  'Intensidade da supressão': 'Suppression strength',
  'Mais alto corta mais ruído, mas pode abafar a voz.': 'Higher cuts more noise but can muffle your voice.',
  'Evita que os outros ouçam o próprio áudio voltando pelo seu microfone.': 'Keeps others from hearing their own audio coming back through your mic.',
  'O supressor RNNoise não carregou neste navegador: está sendo usado o do próprio navegador.': 'RNNoise didn’t load in this browser: the browser’s own suppressor is being used.',
  'Vídeo': 'Video',
  'Testar vídeo': 'Test video',
  'Parar vídeo': 'Stop video',
  'Só você vê esta prévia.': 'Only you see this preview.',
  'Sua câmera já está ligada na sala.': 'Your camera is already on in the room.',
  'Não foi possível abrir a câmera.': 'Couldn’t open the camera.',
  'Você está ao vivo. As mudanças valem na hora.': 'You’re live. Changes apply right away.',
  'Resolução original da tela': 'Original screen resolution',
  '“Fonte” mantém a resolução da tela ou janela compartilhada.': '“Source” keeps the resolution of the shared screen or window.',
  '60 FPS para jogos e vídeos; 15 FPS economiza internet.': '60 FPS for games and videos; 15 FPS saves bandwidth.',
  'Se a rede ou o processador não aguentarem, a resolução cai antes dos FPS, para a imagem não travar.': 'If the network or CPU can’t keep up, resolution drops before FPS so the picture doesn’t freeze.',
  'Áudio da transmissão': 'Stream audio',
  'Qualidade do áudio': 'Audio quality',
  'Sempre estéreo (Opus). 510 kbps é o máximo que o WebRTC permite.': 'Always stereo (Opus). 510 kbps is WebRTC’s ceiling.',
  'Liga ou silencia o som do que você está transmitindo.': 'Turns the sound of what you’re streaming on or off.',
  'Esta transmissão não tem áudio.': 'This stream has no audio.',
  'O áudio da transmissão pode ser ligado ou silenciado pelo menu da transmissão enquanto você estiver ao vivo.': 'Stream audio can be turned on or off from the stream menu while you’re live.',
  'Sons da chamada': 'Call sounds',
  'Efeitos sonoros criados por': 'Sound effects made by',
  'Avisos sonoros de quem entra, sai, transmite e muta.': 'Sound cues when people join, leave, stream and mute.',
  'Volume dos sons': 'Sound volume',
  'Relativo ao volume de saída.': 'Relative to the output volume.',
  'Quais sons tocar': 'Which sounds play',
  'Ouvir': 'Play',
  'Ouvir: {name}': 'Play: {name}',
  'Entrada e saída de pessoas': 'People joining and leaving',
  'Alguém entra ou sai da sala.': 'Someone joins or leaves the room.',
  'Transmissões': 'Streams',
  'Alguém começa ou para de transmitir.': 'Someone starts or stops streaming.',
  'Espectadores': 'Viewers',
  'Alguém começa ou para de assistir uma transmissão.': 'Someone starts or stops watching a stream.',
  'Você liga ou desliga o microfone.': 'You mute or unmute your mic.',
  'Você silencia ou ativa o áudio da sala.': 'You deafen or undeafen.',
  'Você liga ou desliga a câmera.': 'You turn your camera on or off.',
  'Menções no chat': 'Chat mentions',
  'Alguém menciona você.': 'Someone mentions you.',
  'Exibição': 'Display',
  'Cartões de quem não tem câmera nem transmissão aparecem na grade.': 'Cards of people without camera or stream show up in the grid.',
  'Esconder a faixa de participantes': 'Hide the participant strip',
  'No modo destaque, a fileira de pessoas embaixo da tela fica recolhida.': 'In focus mode, the row of people under the screen stays collapsed.',
  'Volumes individuais': 'Per-person volumes',
  'Redefinir volumes por pessoa': 'Reset per-person volumes',
  '{n} pessoa(s) com volume ou silêncio próprio.': '{n} person(s) with their own volume or mute.',
  'Redefinir': 'Reset',
  'Redefinir volumes?': 'Reset volumes?',
  'Todo mundo volta para 100% e sem silêncio.': 'Everyone goes back to 100% and unmuted.',
  'Volumes redefinidos.': 'Volumes reset.',
  'Automático': 'Automatic',
  'Português': 'Portuguese',
  'Inglês': 'English',
  'Português (do sistema)': 'Portuguese (system)',
  'English (do sistema)': 'English (system)',
  'Idioma do kScreen': 'kScreen language',
  'Mensagens do chat e nomes nunca são traduzidos.': 'Chat messages and names are never translated.',
  'Recarregar agora?': 'Reload now?',
  'O idioma muda depois de recarregar. Você volta para a mesma sala.': 'The language changes after a reload. You’ll come back to the same room.',
  'O idioma muda depois de recarregar a página.': 'The language changes after reloading the page.',
  'Recarregar': 'Reload',
  'Teclado e mouse': 'Keyboard and mouse',
  'Abrir ou fechar as configurações': 'Open or close settings',
  'Fechar menus e janelas': 'Close menus and windows',
  'Enviar mensagem no chat': 'Send a chat message',
  'Nova linha no chat': 'New line in chat',
  'Editar sua última mensagem (chat vazio)': 'Edit your last message (empty chat box)',
  'Colar imagem no chat': 'Paste an image into chat',
  'Pôr uma pessoa ou transmissão em destaque': 'Focus a person or stream',
  'Volume e opções de uma pessoa ou transmissão': 'Volume and options for a person or stream',
  'Painel admin (dentro de uma sala)': 'Admin panel (inside a room)',
  'Clique': 'Click',
  'Clique direito': 'Right-click',
  'Diagnóstico': 'Diagnostics',
  'Forçar conexão pelo TURN': 'Force connection through TURN',
  'Manda tudo pelo servidor TURN, mesmo quando o P2P direto funcionaria. Vale a partir da próxima vez que você entrar numa sala.': 'Sends everything through the TURN server, even when direct P2P would work. Takes effect the next time you join a room.',
  'TURN forçado: vale na próxima sala.': 'TURN forced: applies in the next room.',
  'TURN volta a ser usado só quando precisa.': 'TURN is back to being used only when needed.',
  'Restaurar': 'Restore',
  'Restaurar configurações padrão': 'Restore default settings',
  'Dispositivos, volumes, processamento de voz, qualidade da transmissão, sons e exibição voltam ao padrão.': 'Devices, volumes, voice processing, stream quality, sounds and display go back to their defaults.',
  'Restaurar tudo?': 'Restore everything?',
  'Todas as configurações deste navegador voltam ao padrão. Volumes por pessoa e o idioma não mudam.': 'Every setting in this browser goes back to its default. Per-person volumes and the language stay.',
  'Configurações restauradas.': 'Settings restored.',
  'As configurações ficam salvas neste navegador.': 'Settings are saved in this browser.'
};

// --- matching -------------------------------------------------------------

const exact = new Map();
const patterns = [];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [pt, en] of Object.entries(EN)) {
  if (!/\{\w+\}/.test(pt)) {
    exact.set(pt, en);
    continue;
  }
  const names = [];
  const source = pt.split(/(\{\w+\})/).map((part) => {
    const m = part.match(/^\{(\w+)\}$/);
    if (!m) return escapeRe(part);
    names.push(m[1]);
    return '(.+?)';
  }).join('');
  patterns.push({ re: new RegExp(`^${source}$`), names, en });
}
// Longer keys first, so "{name} (Você), transmitindo" wins over "{name}, transmitindo".
patterns.sort((a, b) => b.re.source.length - a.re.source.length);

function translateCore(text) {
  const hit = exact.get(text);
  if (hit !== undefined) return hit;
  for (const p of patterns) {
    const m = text.match(p.re);
    if (!m) continue;
    const values = {};
    p.names.forEach((name, i) => { values[name] = exact.get(m[i + 1]) ?? m[i + 1]; });
    return p.en.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
  }
  return null;
}

// Translates a whole string (keeps the whitespace around it). Returns the input when unknown.
export function tr(text) {
  if (lang === 'pt' || typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed || !/[A-Za-zÀ-ú]/.test(trimmed)) return text;
  const out = translateCore(trimmed);
  return out == null ? text : text.replace(trimmed, out);
}

// --- live DOM translation ---------------------------------------------------

const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
const SKIP = '#log-console, script, style, [data-no-tr]';

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement?.closest(SKIP)) return;
    const next = tr(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (node.closest?.(SKIP)) return;
  translateAttrs(node);
  // User content (chat messages, names) is never translated.
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => (n.nodeType === Node.ELEMENT_NODE && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const next = tr(n.nodeValue);
      if (next !== n.nodeValue) n.nodeValue = next;
    } else {
      translateAttrs(n);
    }
  }
}

function translateAttrs(el) {
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const next = tr(value);
    if (next !== value) el.setAttribute(name, next);
  }
}

// Translates a subtree right away (for nodes read before they reach the page, e.g. search).
export function translateTree(node) {
  if (lang !== 'pt' && node) translateNode(node);
}

export function startTranslating() {
  document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
  if (lang === 'pt') return;
  translateNode(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes') { if (!r.target.closest?.(SKIP)) translateAttrs(r.target); }
      else for (const n of r.addedNodes) translateNode(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
