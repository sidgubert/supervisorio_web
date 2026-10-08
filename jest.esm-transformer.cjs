/**
 * Transformador do Jest para dependências publicadas só em ESM.
 *
 * Em tempo de execução o Node (22.13+) carrega essas dependências normalmente,
 * mas o Jest roda o projeto em CommonJS e não entende `import`/`export`. Este
 * transformador converte apenas os pacotes listados em transformIgnorePatterns
 * (package.json) para CommonJS, com esModuleInterop: o código ESM usa
 * importações padrão de módulos CommonJS (ex: `import os from "node:os"`).
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
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha1')
      .update(ts.version)
      .update(JSON.stringify(compilerOptions))
      .update(sourcePath)
      .update(sourceText)
      .digest('hex');
  },
};
