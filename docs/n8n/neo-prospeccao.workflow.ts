// Versão inicial do workflow (referência). A versão viva está no n8n: id AUfS5VcbEAQtkW1m (inclui a conferência de WhatsApp na Evolution).
import { workflow, node, trigger, sticky, newCredential, ifElse, splitInBatches, nextBatch, languageModel, expr } from '@n8n/workflow-sdk';

const agenda = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'A cada 20 min (seg–sex, 9h–18h)',
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 */20 9-17 * * 1-5' }] } },
    position: [0, 300]
  },
  output: [{}]
});

const reservar = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Reservar envios',
    parameters: { operation: 'executeQuery', query: 'select * from neo.reservar(3)' },
    credentials: { postgres: newCredential('Supabase — neo_n8n') },
    position: [220, 300]
  },
  output: [{ envio_id: '00000000-0000-0000-0000-000000000001', oportunidade_id: '00000000-0000-0000-0000-000000000002', tipo: 'primeira', telefone: '+5561999990000', destino: '+5561988887777', teste: true, instancia: 'TESTE', contexto: { empresa: { nome: 'Clínica Exemplo', segmento: 'clínica odontológica', bairro: 'Asa Norte', cidade: 'Brasília' }, diagnostico: { presenca: 'SEM_SITE', resumo: 'Não encontramos site próprio da empresa.' }, oportunidade: { tipo: 'A', objetivo: 'primeiro site profissional + atendimento com IA no WhatsApp' }, regras: [] }, mensagem_anterior: null }]
});

const loop = splitInBatches({
  version: 3,
  config: { name: 'Próximo envio', parameters: { batchSize: 1 }, position: [440, 300] }
});

const modelo = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter',
  version: 1,
  config: {
    name: 'OpenRouter',
    parameters: { model: 'anthropic/claude-sonnet-4.6', options: { temperature: 0.4, maxTokens: 400 } },
    credentials: { openRouterApi: { id: 'ZhxqkDrPUTNN7obG', name: 'openrouter_cloudfy' } },
    position: [660, 520]
  }
});

const redigir = node({
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  version: 1.9,
  config: {
    name: 'Redigir mensagem do Neo',
    parameters: {
      promptType: 'define',
      text: expr('Tipo de mensagem: {{ $json.tipo }}\n\nContexto verificado da empresa (JSON):\n{{ JSON.stringify($json.contexto) }}\n\nMensagem anterior enviada (só para follow-up):\n{{ $json.mensagem_anterior || "(nenhuma)" }}\n\nEscreva somente o texto final da mensagem de WhatsApp, sem aspas e sem comentários.'),
      messages: {
        messageValues: [
          {
            type: 'SystemMessagePromptTemplate',
            message: 'Você é o Neo, consultor de IA da IONEXT, empresa que cria sites, landing pages, sistemas e atendimento com inteligência artificial. Você escreve a PRIMEIRA mensagem de WhatsApp para uma empresa, ou um FOLLOW-UP curto quando ela não respondeu.\n\nRegras obrigatórias:\n1. Use apenas os fatos do contexto. Nunca invente números, clientes, cases, resultados, preços, prazos ou promessas.\n2. Tom consultivo, cordial e humano, em português do Brasil. Nada de pressão, urgência artificial ou exageros.\n3. Nunca diga que a empresa está mal, errada, atrasada ou ultrapassada. Fale de oportunidade.\n4. Primeira mensagem: apresente-se como Neo, da IONEXT; cite o nome da empresa e o bairro; diga em uma frase o que notou (o resumo do diagnóstico) e como a IONEXT pode ajudar (o objetivo); termine com uma pergunta aberta.\n5. Follow-up: duas ou três frases, retome a conversa anterior com leveza, sem repetir tudo, e termine com uma pergunta simples.\n6. Até 4 frases, sem links, sem anexos, sem emojis em excesso (no máximo um).\n7. A última linha deve ser exatamente: Se preferir não receber mensagens, é só me avisar.'
          }
        ]
      }
    },
    subnodes: { model: modelo },
    position: [660, 300]
  },
  output: [{ text: 'Olá! Sou o Neo, da IONEXT. Vi que a Clínica Exemplo, na Asa Norte, ainda não tem um site próprio e pensei que um site profissional com atendimento por IA no WhatsApp poderia ajudar seus pacientes a agendar com mais facilidade. Faz sentido conversarmos sobre isso?\nSe preferir não receber mensagens, é só me avisar.' }]
});

const validar = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validar mensagem',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: "const env = $('Próximo envio').item.json;\nconst FRASE = 'Se preferir não receber mensagens, é só me avisar.';\nconst msg = String($json.text || '').trim().replace(/^[\"']+|[\"']+$/g, '').trim();\nconst problemas = [];\nif (!/ionext/i.test(msg)) problemas.push('não cita a IONEXT');\nif (!msg.endsWith(FRASE)) problemas.push('não termina com a frase de opt-out');\nif (/https?:\\/\\/|www\\.|\\.com\\b|\\.com\\.br\\b/i.test(msg)) problemas.push('contém link');\nif (/R\\$\\s?\\d|\\d+\\s?%/.test(msg)) problemas.push('cita preço ou porcentagem');\nif (msg.length < 60 || msg.length > 700) problemas.push('tamanho fora do limite (' + msg.length + ')');\nreturn { json: {\n  envio_id: env.envio_id,\n  tipo: env.tipo,\n  teste: env.teste,\n  instancia: env.instancia,\n  numero: String(env.destino || '').replace(/\\D/g, ''),\n  mensagem: msg,\n  valida: problemas.length === 0,\n  problemas: problemas.join('; ')\n} };"
    },
    position: [880, 300]
  },
  output: [{ envio_id: '00000000-0000-0000-0000-000000000001', tipo: 'primeira', teste: true, instancia: 'TESTE', numero: '5561988887777', mensagem: 'Olá! Sou o Neo, da IONEXT...', valida: true, problemas: '' }]
});

const mensagemOk = ifElse({
  version: 2.3,
  config: {
    name: 'Mensagem aprovada?',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.valida }}'), rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }]
      }
    },
    position: [1100, 300]
  }
});

const enviar = node({
  type: 'n8n-nodes-evolution-api.evolutionApi',
  version: 1,
  config: {
    name: 'Enviar WhatsApp',
    parameters: {
      resource: 'messages-api',
      operation: 'send-text',
      instanceName: expr('{{ $json.instancia }}'),
      remoteJid: expr('{{ $json.numero }}'),
      messageText: expr('{{ $json.mensagem }}'),
      options_message: { delay: 2500, linkPreview: false }
    },
    credentials: { evolutionApi: { id: 'ijXLkpe3tamH9Bvw', name: 'evolution_cloudfy' } },
    onError: 'continueErrorOutput',
    position: [1320, 200]
  },
  output: [{ key: { id: 'ABC123' }, status: 'PENDING' }]
});

const registrarOk = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Registrar envio',
    parameters: {
      operation: 'executeQuery',
      query: 'select neo.registrar_envio($1::uuid, $2, true) as resultado',
      options: { queryReplacement: expr("{{ [ $('Validar mensagem').item.json.envio_id, $('Validar mensagem').item.json.mensagem ] }}") }
    },
    credentials: { postgres: newCredential('Supabase — neo_n8n') },
    position: [1540, 120]
  },
  output: [{ resultado: { ok: true, teste: true } }]
});

const pausa = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: {
    name: 'Pausa aleatória (1–3 min)',
    parameters: { resume: 'timeInterval', amount: expr('{{ 60 + Math.floor(Math.random() * 120) }}'), unit: 'seconds' },
    position: [1760, 120]
  },
  output: [{ resultado: { ok: true } }]
});

const registrarFalha = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Registrar falha no envio',
    parameters: {
      operation: 'executeQuery',
      query: 'select neo.registrar_envio($1::uuid, $2, false, $3) as resultado',
      options: { queryReplacement: expr("{{ [ $('Validar mensagem').item.json.envio_id, $('Validar mensagem').item.json.mensagem, 'Evolution: ' + ($json.error?.message || JSON.stringify($json.error || $json)).slice(0, 400) ] }}") }
    },
    credentials: { postgres: newCredential('Supabase — neo_n8n') },
    position: [1540, 300]
  },
  output: [{ resultado: { ok: true, teste: true } }]
});

const registrarRecusa = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.7,
  config: {
    name: 'Registrar mensagem recusada',
    parameters: {
      operation: 'executeQuery',
      query: 'select neo.registrar_envio($1::uuid, $2, false, $3) as resultado',
      options: { queryReplacement: expr("{{ [ $json.envio_id, $json.mensagem, 'Validação: ' + $json.problemas ] }}") }
    },
    credentials: { postgres: newCredential('Supabase — neo_n8n') },
    position: [1320, 460]
  },
  output: [{ resultado: { ok: true, teste: true } }]
});

const nota = sticky('## Neo — prospecção (modo teste)\nO banco decide tudo: janela seg–sex 9h–18h, 15/dia, opt-out, só celular, follow-up após 3 dias.\nEnquanto `neo.config.modo_teste = true`, TODAS as mensagens vão para `numero_teste` e o funil não muda.\nMensagem que não passa na validação NÃO é enviada (fica registrada como falha).', [reservar, loop], { color: 4 });

export default workflow('neo-prospeccao', '(Ionext - Neo) Prospecção — primeira mensagem + follow-up')
  .add(agenda)
  .to(reservar)
  .to(loop.onEachBatch(
    redigir.to(validar).to(
      mensagemOk
        .onTrue(enviar.to(registrarOk).to(pausa).to(nextBatch(loop)))
        .onFalse(registrarRecusa.to(nextBatch(loop)))
    )
  ))
  .add(enviar.onError(registrarFalha.to(nextBatch(loop))))
  .add(nota);
