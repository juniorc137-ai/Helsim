# SimClin – Monitor Cardíaco para Simulação Clínica

Monitor multiparamétrico simulado (ECG, SpO₂, respiração, PA, temperatura) controlado
remotamente por um instrutor, via WebSocket, em salas identificadas por código de 4 dígitos.

```bash
npm install
npm start        # http://localhost:3000
npm test         # testes do motor de cenários (node:test, sem dependências extras)
```

## Arquitetura

| Componente | Arquivo | Função |
|---|---|---|
| Servidor de retransmissão | `server.js` | Express + WebSocket; o instrutor publica o estado e os monitores da sala o recebem |
| Monitor do paciente | `public/index.html` (tela *Monitor*) | Gera as ondas (ECG, pletismografia, respiração), alarmes visuais e sonoros |
| Aplicação do instrutor | `public/index.html` (tela *Instrutor*) | Modo manual (cenários rápidos, ritmo, vitais) e modo automático (*Roteiro*) |
| Motor de cenários | `public/sim-engine.js` | Máquina de estados com tendências, eventos, *handlers*, gatilhos e registro de sessão |
| Biblioteca de cenários | `public/scenarios.js` | Cenários programados (sepse, FA com RVR, PCR em FV) |
| Captura e debriefing | `public/captura.html` | Agenda, gravação multicâmera, anotações, debriefing, avaliações e relatórios |
| Regras da captura | `public/captura-core.js` | Recorrência e conflitos de agenda, pontuação, amostragem, relatórios, CSV/iCalendar |

### Motor de cenários (modo automático)

O desenho reproduz, em versão aberta e simplificada, os conceitos documentados pela Laerdal
para o SimDesigner/LLEAP (*SimDesigner Help*, 2020, Rev. T):

| Conceito Laerdal | No SimClin | Comportamento |
|---|---|---|
| **Cenário**: evolução sequencial pré-programada de estados, com vários desfechos | objeto em `scenarios.js` | estados, eventos, handlers e indicadores |
| **Estado**: condição do paciente num período | `states.<id>` | `vitals` aplicados na entrada, `trends`, `transitions`, `timeout` |
| **Tendência** (*trend*): mudança de parâmetros que depende só do tempo | `trends: { sbp: { to, duration } }` ou `{ by, duration }` | interpolação suavizada até o alvo |
| **Evento**: intervenção dos participantes | `events[]` | botões "toque para registrar" na aba *Roteiro* |
| **Handler**: regra entre eventos e respostas automáticas | `handlers[]` com `on` (evento) ou `when` (condição) | ações `set`, `add`, `trend`, `log`, `goto` |
| **Gatilho** com AND/OR, contadores e limite de tempo | `transitions[].if`, `timeout` | `{all}`, `{any}`, `{not}`, `{event, count, scope}`, `{param, op, value}`, `{elapsed}` |
| Gatilhos zerados ao entrar num estado | contadores por estado | `scope: "session"` usa o contador da sessão inteira |
| Modo manual sobrepondo o automático | sliders/ritmos durante o roteiro | ajuste vira *override* registrado e cancela a tendência daquele parâmetro |
| Registro de eventos com carimbo de tempo e vitais | `log`, aba *Debriefing* | indicadores com tempo-alvo, trajetória de estados, comentários, exportação CSV/JSON |

O motor é determinístico (o tempo só avança por `tick(dt)`), o que permite testar
cenários automaticamente (`test/engine.test.js`) e reproduzir sessões.

### Como escrever um cenário

```js
{
  id: "meu_caso", title: "…", summary: "…", objectives: ["…"],
  baseline: { rhythm: "sinusal", hr: 90, spo2: 94, rr: 22, temp: 37, sbp: 110, dbp: 70 },
  events:   [{ id: "o2", label: "O₂ suplementar", cat: "Respiração" }],
  handlers: [{ id: "o2_resp", on: "o2", once: true,
               actions: [{ trend: { spo2: { by: 4, duration: 60 } } }], log: "SpO₂ melhora" }],
  initial: "s1",
  states: {
    s1: { label: "Apresentação", trends: { spo2: { to: 86, duration: 300 } },
          transitions: [{ if: { event: "o2" }, goto: "s2" }],
          timeout: { after: 360, goto: "pior" } },
    s2:   { label: "Melhora", end: true, outcome: "Estabilizado" },
    pior: { label: "Insuficiência respiratória", end: true, outcome: "Deterioração" },
  },
  kpis: [{ label: "O₂ ofertado", event: "o2", target: 120 }],
}
```

Valide com `SimEngine.validateScenario(cenario)` (lista vazia = válido) e adicione um
teste em `test/engine.test.js` cobrindo o caminho ideal e o caminho sem intervenção.

### Limites conhecidos

- Não há modelo fisiológico contínuo (equações cardiovasculares/respiratórias). As respostas
  são roteirizadas, como nos cenários de estados e tendências; para fisiologia acoplada, o
  caminho natural seria integrar um motor aberto como o Pulse Physiology Engine
  (Bray et al., 2019, doi:10.1007/s42399-019-00053-w).
- O motor roda no navegador do instrutor; se a página do instrutor for fechada, o roteiro
  em andamento é perdido (os monitores mantêm o último estado).

## HELSIM (gestão, gravação e debriefing)

`/captura.html` (botão **HELSIM · Agenda · Debriefing** na tela inicial), com a identidade
visual Helse Solutions (barra marinho, menu lateral por módulos, tipografia IBM Plex, tema claro
e escuro; ícone HELSIM em `public/img/`, botões de captura em vermelho vivo), reproduz, em implementação aberta, o fluxo de um sistema de gestão de simulação do tipo SimCapture:

| Etapa | No HELSIM |
|---|---|
| Agenda | Calendário mensal de salas, reservas únicas ou recorrentes (até 1 ano), conflito de sala e de equipamento permanente, aprovação de pedidos de docentes, exportação `.ics` |
| Cursos e pessoas | Turmas com estudantes e docentes, importação/exportação CSV (ponte com Moodle/Canvas) |
| Cenários | Objetivos, simulador, biblioteca de anotações com atalhos, avaliações vinculadas, prazo de retenção; importa os cenários do motor |
| Gravação ao vivo | Até 4 vídeos sincronizados (webcams, captura de tela do monitor/PEP, fonte de teste) + microfone, via `MediaRecorder`; anotações por teclas 1–9 ou texto; avaliação ao vivo; transcrição opcional (Web Speech API) |
| Dados do simulador | A estação entra na sala de 4 dígitos e grava sinais vitais, mudanças de estado e intervenções registradas no roteiro (`{type:"event"}` retransmitido pelo servidor) |
| Debriefing | Reprodução sincronizada (grade, lado a lado, imagem sobre imagem, câmera única; 0,5–2×), linha do tempo com FC/SpO₂/PAS e marcadores, sinais vitais sobrepostos ao vídeo, notas |
| Avaliações | Checklists (feito/não feito), escalas, múltipla escolha, texto; itens críticos; tipos antes/após/reflexão (estudante) e avaliador/monitoramento (docente) |
| Relatórios | Horas por sala/curso/mês, horas-participante, desempenho por estudante, análise por item, anotações por categoria, exportação CSV |
| Perfis | Administrador, docente e estudante (estudante vê só as próprias sessões e responde os próprios instrumentos) |

Os dados ficam no navegador (IndexedDB): os vídeos são gravados em blocos de 2 s, de modo que
uma gravação interrompida é recuperada ao reabrir a página. A câmera exige contexto seguro
(`https://` ou `http://localhost`). Não há contas nem servidor de arquivos: para uso
multiusuário institucional seria preciso um back-end com autenticação, armazenamento de
vídeo e LTI 1.3. A gravação de pessoas exige consentimento e prazo de retenção (LGPD,
Lei 13.709/2018), ambos presentes na interface.


### Biblioteca de exemplo baseada em evidências

O botão **Carregar biblioteca** (Painel › Comece por aqui) cria 5 cursos, 13 cenários e 24 avaliações e
checklists (`public/captura-biblioteca.js`) construídos a partir de 24 artigos de *Clinical Simulation in
Nursing*, v. 105 (2025), incluindo a revisão 2025 dos padrões INACSL (prebriefing, facilitação, debriefing e
integridade profissional), e das diretrizes clínicas que eles usam (AHA 2020, ACOG 2020, ESC 2023). Cada
cenário e avaliação guarda suas referências completas com DOI; a lista consolidada aparece em **Cenários**.
Os itens são redação própria alinhada às fontes; instrumentos protegidos não são reproduzidos.

### Câmera fixa da sala por link

Em **Configurações › Salas › Câmeras** (ou em **Sessão ao vivo › + Câmera da sala por link**) cada sala
guarda o link das suas câmeras IP, que aparecem como fontes prontas ao iniciar uma sessão naquela sala.
O navegador aceita **WebRTC (WHEP)**, **HLS (.m3u8)**, **MJPEG**, imagem atualizada (snapshot) e MP4/WebM.
Câmeras só **RTSP** precisam de um conversor na rede da sala (MediaMTX ou go2rtc), que publica o mesmo
vídeo em WebRTC/HLS. HLS, MJPEG e snapshot passam por um canvas e exigem CORS liberado; uma página em
https não abre câmeras em http (conteúdo misto), então use o servidor local nesse caso.

### Módulos do laboratório (somente docente e administrador)

O grupo **Laboratório · restrito** do menu só aparece nos perfis docente e administrador (o **Almoxarifado** só para o administrador); o perfil
estudante não vê as telas e as ações são recusadas mesmo se chamadas diretamente.

- **Prontuário eletrônico simulado**: pacientes vinculados a cenários, prescrição numerada (digitação →
  liberação), aprazamento automático (N/Nh, 1x/dia e 2x/dia a partir das 06:00), checagem da administração,
  aprazamento com motivo, suspensão e reativação, itens SOS, relógio do cenário com tolerância de atraso,
  alerta de alergia com sinônimos (por exemplo dipirona e metamizol), histórico exportável em CSV, relatório
  de pontualidade e sinais vitais com NEWS2 e tendência. Na **Sessão ao vivo**, a aba *Prontuário* checa
  horários e itens SOS, e cada registro vira anotação “Prontuário” na linha do tempo do debriefing.
- **Almoxarifado (Helse Log)**: mapa dos armários com pictogramas, inspetor de compartimento com entrada e
  saída, inventário filtrável, movimentações auditadas, etiqueta com QR code (carregado da internet sob
  demanda), alerta de estoque crítico no menu e no painel, e lista de reposição até 1,5 × o mínimo.
- **Ocupação das salas**: visão do dia por sala (status agora, taxa de ocupação das 7h às 22h) e grade
  horária, lida da mesma agenda de reservas.

As regras (horários, atraso, NEWS2, alergias, estoque, ocupação) ficam em `public/captura-modulos.js`
(`HC_CLIN`) e têm testes em `test/captura.test.js`.

### Modo de senhas (cadastro por e-mail)

Quando o HELSIM é aberto pelo servidor (`npm start`, endereço `/captura.html`), o acesso exige conta:

1. **Cadastro**: a pessoa informa nome e e-mail; o servidor gera uma **senha temporária aleatória**
   (12 caracteres, válida por 24 h) e a envia ao e-mail.
2. **Primeiro acesso**: com a senha temporária, a única tela disponível é a de **cadastrar a senha
   definitiva** (mínimo de 10 caracteres, letras e números, diferente da temporária). Só depois o sistema abre.
3. **Perfis**: o primeiro cadastro do servidor vira administrador; os demais entram como estudante e o
   administrador promove docentes em **Configurações › Usuários e acesso** (onde também cadastra pessoas,
   envia nova senha temporária e exclui acessos). Estudantes ficam presos ao próprio perfil; docentes podem
   visualizar como estudante.
4. **Recuperação**: “Esqueci minha senha” envia outra senha temporária e invalida a anterior.

Segurança: senhas com scrypt e sal por usuário, sessões de 12 h guardadas só como hash, bloqueio de 15 min
após 5 erros, limite de pedidos por IP e respostas que não revelam se um e-mail já tem cadastro. As contas
ficam em `data/users.json` (fora do Git).

E-mail real por SMTP (por exemplo, o servidor de e-mail da instituição):

```bash
SMTP_HOST=smtp.exemplo.edu.br SMTP_PORT=587 SMTP_USER=helsecapture@exemplo.edu.br \
SMTP_PASS='senha-do-app' SMTP_FROM='HELSIM <helsecapture@exemplo.edu.br>' \
PUBLIC_URL=https://simulacao.exemplo.edu.br npm start
```

Sem `SMTP_HOST`, o servidor roda em modo de teste: cada e-mail é salvo em `data/outbox/`. `HC_AUTH=0`
desliga o modo de senhas. O arquivo único e o link de demonstração não têm servidor e mantêm a troca livre de perfil.

### Banco de dados central (vários computadores)

Com o modo de senhas ativo, o servidor também guarda um **banco central** (`store.js`, rota `/api/data`):
cadastros, cursos, agenda, cenários, sessões, avaliações, prontuário, almoxarifado e vídeos passam a ser
compartilhados por todos os computadores que acessam o mesmo servidor.

- **Sincronização automática**: cada navegador trabalha sobre uma cópia local (continua funcionando sem rede)
  e conversa com o servidor a cada 12 s, ao voltar para a janela e logo após cada alteração. A barra inferior
  mostra o estado (sincronizado, enviando, sem conexão).
- **Edições simultâneas**: o documento tem número de revisão; se outra pessoa gravou antes, o navegador mescla
  item a item (mescla de três vias: o que cada lado mudou desde a última versão comum) e reenvia. Mudanças em
  itens diferentes nunca se perdem; no mesmo campo do mesmo item, prevalece a última gravação.
- **Vídeos**: enviados em blocos ao servidor ao encerrar a gravação (com nova tentativa automática) e baixados
  sob demanda nos outros computadores.
- **Permissões**: administrador lê e grava tudo; docente também, exceto o almoxarifado, que o servidor não lhe envia e preserva quando ele grava. O estudante recebe só as próprias sessões,
  cursos e reservas (sem prontuário, almoxarifado nem dados de colegas) e só consegue acrescentar as próprias
  avaliações. “Apagar tudo” fica restrito ao administrador e avisa que apaga no servidor.
- **Cópias de segurança**: `data/db.json` com cópias automáticas em `data/backups/` (no máximo uma a cada
  10 min, as 30 mais recentes); vídeos em `data/media/`. `HC_DATA_DIR` muda a pasta e `HC_SYNC=0` desliga o
  banco central (cada navegador volta a guardar só os próprios dados).

### Aplicativo de computador (macOS e Windows)

A pasta `desktop/` empacota o HELSIM como aplicativo próprio (Electron). Ele abre numa janela própria,
sem navegador, com menu em português e permissão de câmera e microfone.

- Se já houver um servidor do HELSIM na porta 3000 (por exemplo, o que inicia com o computador), o app se
  conecta a ele. Senão, liga o servidor embutido e o desliga ao sair.
- Os dados ficam em `~/HelseCapture/SimClin/data` quando essa pasta existe; senão, na pasta de dados do app.

```bash
cd desktop
npm install
npm run dist        # macOS: gera dist/mac*/HELSIM.app (sem assinatura, para uso no próprio Mac)
npm run dist:dmg    # macOS: instalador .dmg
npm run dist:win    # Windows: instalador .exe (gerar no Windows)
```

