# Neo — envio da prospecção pelo WhatsApp

## Como funciona

1. Você aprova a empresa no painel ("Aprovar para o Neo").
2. O workflow do n8n **(Ionext - Neo) Prospecção — primeira mensagem + follow-up** roda a cada 20 min, seg–sex, das 9h às 18h.
   - Ele chama `neo.reservar(3)` no Supabase.
3. O banco decide o que pode ser enviado. O n8n não consegue contornar estas regras:
   - Janela de envio e limite diário (15).
   - Opt-out (CNPJ, telefone, e-mail, domínio).
   - Só celular comercial; telefone fixo não entra.
   - Um envio por oportunidade.
   - Follow-up 3 dias depois, se não houver resposta.
4. A IA redige a mensagem só com os fatos verificados da ficha.
   - Um nó de validação recusa a mensagem se ela não citar a IONEXT, não terminar com a frase de opt-out, tiver link, citar preço/porcentagem ou ter tamanho fora do limite.
   - Mensagem recusada não é enviada; fica registrada como falha com o motivo.
5. O envio sai pela instância `TESTE` da Evolution e é registrado em `neo.envio`.
   - Fora do modo teste, a oportunidade passa para "abordada".
   - O histórico aparece na ficha da empresa, no cartão "Neo (WhatsApp)".

## Modo teste (ligado por padrão)

Com `modo_teste = true`, **todas** as mensagens vão para o seu número e nada muda no funil.

## Configuração (uma vez)

1. **Senha do usuário do n8n.** No Supabase → SQL Editor, gere uma senha forte e rode:
   ```sql
   alter role neo_n8n password 'COLOQUE-UMA-SENHA-FORTE';
   ```
   O usuário `neo_n8n` só pode executar as funções `neo.*`. Ele não lê nem altera tabelas.
2. **Credencial no n8n.** Credentials → New → Postgres:
   - Host: o mesmo do *Session pooler* (Supabase → Connect).
   - Porta: 5432.
   - Database: `postgres`.
   - User: `neo_n8n.chqvbhodmcxdttfxvwpm`.
   - Password: a senha do passo 1.
   - SSL: require.
3. **Selecione essa credencial** nos 4 nós Postgres do workflow:
   - Reservar envios.
   - Registrar envio.
   - Registrar falha no envio.
   - Registrar mensagem recusada.
4. **Seu número de teste:**
   ```sql
   update neo.config set valor = '+5561XXXXXXXXX' where chave = 'numero_teste';
   ```
5. Aprove 1 ou 2 empresas no painel e clique em **Execute workflow** no n8n. A mensagem chega no seu WhatsApp.

## Ajustes

```sql
select * from neo.config;                                              -- ver tudo
update neo.config set valor = '10' where chave = 'limite_diario';      -- cota
update neo.config set valor = '0'  where chave = 'followup_dias';      -- desliga follow-up
update neo.config set valor = 'false' where chave = 'modo_teste';      -- PRODUÇÃO: envia para as empresas
```

Só desligue o modo teste depois de revisar várias mensagens de teste. Depois disso, ative o workflow no n8n.

## Próxima etapa (ainda não feita)

O Neo de atendimento (workflow `T01LY0pwFesyAYmK`) ainda não sabe que a conversa veio da prospecção. Falta ligar nele:

- `neo.contexto_por_telefone(telefone)`: quem é a empresa e o que foi dito.
- `neo.registrar_resposta(telefone, resumo)`: marca "respondeu".
- `neo.registrar_opt_out(telefone)`: quando pedirem para não receber mensagens.
