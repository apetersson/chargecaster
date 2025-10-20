import { Injectable } from "@nestjs/common";

import type { ConfigDocument } from "./schemas";
import { getRuntimeConfig } from "./runtime-config";

@Injectable()
export class RuntimeConfigService {
  private readonly document: ConfigDocument;

  constructor() {
    const config = getRuntimeConfig();
    if (!config) {
      throw new Error("Runtime configuration not initialised");
    }
    this.document = config;
  }

  getDocument(): ConfigDocument {
    return JSON.parse(JSON.stringify(this.document)) as ConfigDocument;
  }

  getDocumentRef(): ConfigDocument {
    return this.document;
  }
}
