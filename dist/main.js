"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const config_1 = require("@nestjs/config");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.enableCors();
    const config = app.get(config_1.ConfigService);
    const port = Number(config.get('PORT', 3000));
    await app.listen(port);
    console.log(`API em http://localhost:${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map