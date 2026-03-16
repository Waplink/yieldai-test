import { BaseProtocol } from "./BaseProtocol";

export class YieldAIProtocol implements BaseProtocol {
  name = "Yield AI";

  async buildDeposit(): Promise<{
    type: "entry_function_payload";
    function: string;
    type_arguments: string[];
    arguments: string[];
  }> {
    // Yield AI uses its own deposit flow (modals / API).
    throw new Error("Yield AI deposit transaction is not implemented for native flow");
  }
}
