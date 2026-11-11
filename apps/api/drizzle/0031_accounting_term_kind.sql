-- Termos de aceite assinados já enviados ao contador saíam como "Outro documento": passam a "Termos".
UPDATE "accounting_documents" SET "kind" = 'term'
WHERE "direction" = 'to_accountant' AND "kind" = 'other' AND "original_name" LIKE 'Termo de assinatura eletrônica%';
