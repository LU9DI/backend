# Finalização — relatório profissional

A API usa o relatório profissional estruturado como formato canônico.

- Fonte única: objeto JSON versionado.
- Visualização: painel responsivo.
- Distribuição: e-mail, WhatsApp, SMS e WeChat.
- IA: o relatório determinístico não consome tokens; análises de IA existentes permanecem nos fluxos próprios.
- Runtime: Node, sem Chromium/Puppeteer.

Endpoints legados de arquivo de relatório foram aposentados e retornam 410 Gone.
