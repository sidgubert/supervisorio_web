/**
 * Transformador do Jest para código JavaScript em ESM (`import`/`export`).
 *
 * O Jest roda em CommonJS e não entende `import`/`export`. Este transformador
 * converte para CommonJS, com esModuleInterop (o código ESM usa importações
 * padrão de módulos CommonJS, ex: `import os from "node:os"`):
 * - no backend, só as dependências publicadas apenas em ESM, listadas em
 *   transformIgnorePatterns (em tempo de execução, o Node 22.13+ as carrega
 *   normalmente);
 * - no frontend, os módulos de public/js e os próprios testes.
 */
const { createHash } = require('crypto');
const ts = require('typescript');

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2021,
  esModuleInterop: true,
  allowJs: true,
  inlineSourceMap: true,
};

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions,
    });
    return { code: outputText };
  },
  // `instrument` entra na chave: com cobertura (--coverage), o Jest instrumenta
  // o resultado; sem ela no cache, reaproveitaria o código não instrumentado
  // de uma execução comum e a cobertura sairia zerada.
  getCacheKey(sourceText, sourcePath, options = {}) {
    return createHash('sha1')
      .update(ts.version)
      .update(JSON.stringify(compilerOptions))
      .update(sourcePath)
      .update(sourceText)
      .update(String(Boolean(options.instrument)))
      .digest('hex');
  },
};
