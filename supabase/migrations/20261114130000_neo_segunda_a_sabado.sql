-- Neo envia de segunda a sábado (domingo não). O gatilho do n8n roda todos os dias; o banco decide.
update neo.config set valor = '1,2,3,4,5,6' where chave = 'dias_semana';
