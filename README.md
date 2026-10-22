# BeMagic Pets

Um companheiro virtual em pixel art: alimentar, brincar, descansar e dar banho. Cinco temas (jardim, pôr do sol, cosmos, oceano e doces), cores personalizadas, conta confirmada por email e progresso salvo no servidor.

## Stack

Next.js App Router, React, TypeScript, Tailwind CSS, componentes shadcn/ui com Radix, NextAuth (Credentials/JWT), PostgreSQL e Prisma **7** com `@prisma/adapter-pg`. Email transacional via API do Resend, notificações via Web Push. Runtime Node.js 24; pronto para Vercel.

A demonstração é pública e não salva progresso. Uma conta confirmada pode adotar um pet. As necessidades diminuem conforme o tempo do servidor, inclusive com o aplicativo fechado; cuidados têm intervalo de 10 segundos. O pet não morre e pode se recuperar. Nenhum atributo de necessidade enviado pelo navegador é aceito.

## Desenvolvimento

Requisitos: Node.js 24, npm e PostgreSQL.

```sh
npm ci
cp .env.example .env
# Preencha DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL e as configurações de email.
npm run db:migrate
npm run dev
```

Abra http://localhost:3000. Gere `NEXTAUTH_SECRET` com `openssl rand -base64 32`. O Prisma carrega `.env` pela configuração; não envie esse arquivo ao Git.

Para criar conta, configure uma chave Resend e `EMAIL_FROM` em um domínio remetente verificado. Os links expiram em uma hora e são de uso único; a tela permite reenviar. Abrir o link não ativa a conta: o titular precisa definir a senha definitiva para concluir a confirmação. Essa senha substitui a informada no cadastro, impedindo que um pré-cadastro feito por outra pessoa dê acesso à conta. Sem serviço de email configurado, é possível explorar a demonstração e usar o CLI para criar um administrador, mas contas comuns precisam confirmar seu email para entrar.

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

Os testes de integração são opcionais: use um **banco descartável migrado**, defina `DATABASE_URL` e habilite os cenários desejados:

```sh
BACKEND_INTEGRATION_TEST=1 npm test
PUSH_INTEGRATION_TEST=1 npm test
# Requer npm run build antes; inicia um servidor HTTP isolado na porta 3011.
PET_HTTP_INTEGRATION=1 npm test
```

Os cenários verificam confirmação de email, limites persistentes, cron, sessões reais e isolamento dos pets. Eles criam e removem registros temporários. Não execute contra produção.

## Vercel

1. Importe este repositório como projeto Next.js com Node.js 24.
2. Conecte um PostgreSQL gerenciado (por exemplo, Neon); use uma URL com pooling e TLS em `DATABASE_URL`.
3. Cadastre as variáveis de `.env.example` nos ambientes desejados. `NEXTAUTH_URL` deve ser a origem canônica HTTPS, correspondente ao domínio usado no navegador. Em previews, configure a origem de cada ambiente; não reutilize o banco de produção.
4. Antes de publicar uma versão com migrações, rode `npm run db:migrate` em um terminal/CI confiável com a conexão do banco alvo. O build gera o Prisma Client, **não** aplica migrações automaticamente. Se o provedor exigir conexão direta para migrações, use essa URL apenas no processo de migração.
5. Build padrão: `npm run build`. Nunca exponha `DATABASE_URL`, `NEXTAUTH_SECRET`, `RESEND_API_KEY`, `VAPID_PRIVATE_KEY` ou `CRON_SECRET` em variáveis `NEXT_PUBLIC_*`.

O CLI roda no computador do operador ou em um ambiente administrativo confiável, não em uma função pública da Vercel. O aplicativo não depende de disco persistente nem de tarefas em segundo plano dentro de uma função.

## PWA e notificações opcionais

O manifesto inclui ícones locais 192/512 e instalação standalone. O service worker guarda somente ícones e uma página offline pública: **não** armazena páginas autenticadas, APIs nem dados da conta. Sem rede, o usuário vê uma orientação para reconectar; cuidados offline não são enfileirados.

Para habilitar Web Push:

```sh
npx web-push generate-vapid-keys
openssl rand -hex 32
```

Use o par gerado em `NEXT_PUBLIC_VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`; configure `VAPID_SUBJECT` com um contato `mailto:` válido e o segredo aleatório em `CRON_SECRET` (mínimo 32 caracteres). A chave pública é incorporada no build: faça novo deploy após alterá-la. Proteja e preserve a chave privada.

A permissão é solicitada somente ao clicar em **Ativar notificações**. Há botão para desativar no dispositivo. Chrome/Firefox/Safari compatíveis são atendidos; no iOS, instale na tela inicial e abra a PWA. Produção exige HTTPS. Navegadores sem suporte exibem uma orientação.

`vercel.json` agenda `/api/cron/notify` diariamente, compatível com Vercel Hobby. A rota exige o header `Authorization` com o prefixo `Bearer` seguido do valor de `CRON_SECRET`, ignora contas bloqueadas/não confirmadas e limita lembretes a um por conta por dia. Endpoints são validados e restritos aos provedores Google, Mozilla e Apple; assinaturas expiradas são removidas. Cada execução processa até 20 contas, com até três dispositivos por conta. Para uma base maior, amplie o processamento com fila/paginação e um plano/agendador apropriado antes de oferecer cobertura para todos os usuários. A entrega e a instalação dependem do navegador e não são garantidas.

## Administração via CLI

```sh
npm run admin -- --help
npm run admin -- admin administrador@seu-dominio.com
npm run admin -- list
npm run admin -- suspicious
npm run admin -- review usuario@seu-dominio.com
npm run admin -- block usuario@seu-dominio.com
npm run admin -- unblock usuario@seu-dominio.com
npm run admin -- reset-password usuario@seu-dominio.com
npm run admin -- delete usuario@seu-dominio.com
```

O comando `admin` cria ou atualiza um administrador com email confirmado. Somente o primeiro administrador dispensa autenticação prévia, quando não existe nenhum; o acesso ao banco é a fronteira de confiança desse bootstrap. Depois disso, todas as operações pedem credenciais de um administrador ativo. Senhas são digitadas sem eco no terminal, nunca como argumentos. Exclusão exige confirmação explícita. Não é possível bloquear/excluir o último administrador ativo. Alteração de senha e bloqueio revogam sessões existentes; exclusão remove o pet e assinaturas em cascata. Operações geram auditoria.

`suspicious` lista sinais heurísticos, não veredictos: emails com nomes excessivamente longos/sequências numéricas, falhas repetidas de login e atividade excessiva no jogo. `review` registra a revisão e limpa os sinais. A listagem é limitada às 500 contas mais recentes.

## Proteções e operação

- Senhas com 12–128 caracteres, hash scrypt com salt aleatório; sem senhas/tokens em logs.
- Lista de domínios descartáveis (`disposable-email-domains`), incluindo subdomínios. Atualize a lista periodicamente: nenhum bloqueio por lista detecta todos os provedores.
- Limites de tentativas persistidos no PostgreSQL; apenas o header de IP sobrescrito pela Vercel é confiado. Fora da Vercel, o limite por cliente usa um bucket compartilhado.
- Respostas genéricas para cadastro/reenvio, verificação obrigatória, CSRF do NextAuth e checagem de origem nas mutações.
- Autorização consulta a conta no banco em cada API protegida, inclusive após bloqueio/exclusão.
- Cuidados concorrentes usam controle otimista de versão; personalização não reinicia o intervalo de cuidados.
- Faça backups e restrinja acesso a email, auditoria e banco. Agende limpeza de `VerificationToken` expirados e `RateLimit` antigos conforme o crescimento da base.

`npm audit --omit=dev` não apontou vulnerabilidades na implementação inicial. O tooling de lint gerado pelo Next.js apresenta um aviso transitivo em `braces` (sem versão corrigida disponível na verificação); não é usado nas requisições de produção. Revise os avisos e atualize o tooling quando houver correção, sem fazer downgrade do Next.js.
