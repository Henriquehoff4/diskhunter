# DiskHunter

Analisador de disco para Windows 11: mostra para onde o espaço foi, acha duplicatas confirmadas por conteúdo, caches, instaladores esquecidos e modelos de IA, compara análises ao longo do tempo e ajuda a liberar espaço sem apagar nada sem a sua confirmação.

## Instalar

Em `release/`:

- `DiskHunter Setup 1.0.0.exe`: instalador.
- `DiskHunter-1.0.0-portatil.exe`: não precisa de instalação.

O executável não tem assinatura digital, então o SmartScreen pode avisar na primeira vez. Clique em "Mais informações" e "Executar assim mesmo".

## Desenvolver

Requisitos: Windows, Node 22 ou mais novo, .NET SDK 8.

```
npm install
node node_modules/electron/install.js
dotnet build engine/DiskHunter.Engine -c Release
npm start
```

| Comando | O que faz |
| --- | --- |
| `npm run typecheck` | Verifica tipos |
| `npm test` | Testes de proteção, exclusão, treemap, relatórios e formatos |
| `npm run test:engine` | Testes do motor em .NET, com arquivos temporários pequenos |
| `npm run test:e2e` | App real com fixtures temporárias e dados simulados |
| `npm run perf:disk -- D:\ --sim` | Opcional. Mede o desempenho em um disco real. Nunca roda nas suítes |
| `npm run dist` | Gera o instalador e a versão portátil |

## Testes

Cada teste tem limite de 30 segundos e a suíte normal cabe em 2 minutos. Cenários de milhões de arquivos usam o gerador sintético do motor, que só existe com `DISKHUNTER_TEST=1`, e não criam arquivos no disco. O teste de ponta a ponta leva um arquivo minúsculo de teste para a Lixeira de verdade para exercitar esse caminho: o item `e2e-diskhunter-pode-apagar.bin` pode ser apagado da Lixeira a qualquer momento.

## Arquitetura

- **Motor** (`engine/`): processo .NET 8 separado, que fala NDJSON por stdin e stdout. Lê diretórios com `NtQueryDirectoryFile` em várias threads, sem seguir junções ou links simbólicos, conta links físicos uma única vez e nunca abre arquivos só na nuvem.
- **Processo principal** (`src/main`): ponte com o motor, lista fixa de comandos permitidos, exclusão, protocolo de pré-visualização e exportação.
- **Interface** (`src/renderer`): React sem acesso a Node. Envia só identificadores de itens, nunca caminhos a excluir.

## Como a exclusão é protegida

1. A interface pede um plano com identificadores. O processo principal confere cada item contra as áreas protegidas (`src/shared/protected.ts`) e devolve um token de uso único.
2. A pessoa revisa a lista e confirma. Exclusão permanente pede também a palavra EXCLUIR e um diálogo nativo, e só é oferecida para o que a Lixeira recusou.
3. Na hora de excluir, cada item é conferido de novo: caminho real, tipo, tamanho e data. Duplicatas são comparadas byte a byte com a cópia que fica. Se algo mudou, o item não é tocado.
4. Tudo fica registrado em `history.jsonl`, na pasta de dados do aplicativo.

## Limitações conhecidas

- Só Windows. Discos de rede funcionam, mas a Lixeira pode recusar itens neles.
- Links físicos anteriores à análise só são reconhecidos em NTFS, onde o Windows informa o identificador do arquivo.
- A busca e o ranking mostram até 20 mil resultados por consulta; refine os filtros para ver o restante.
- A comparação de crescimento guarda pastas a partir de 1 MB e os dois primeiros níveis.
- Cada regra de limpeza lista até 500 itens, os maiores.
- A data de uma pasta nem sempre reflete o uso real do conteúdo.
- O espaço só volta ao esvaziar a Lixeira.

## Licença

MIT. Veja `LICENSE`.
