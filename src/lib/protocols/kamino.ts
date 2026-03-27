import { BaseProtocol } from "./BaseProtocol";

export class KaminoProtocol implements BaseProtocol {
  name = "Kamino";

  async buildDeposit(): Promise<{
    type: "entry_function_payload";
    function: string;
    type_arguments: string[];
    arguments: string[];
  }> {
    throw new Error("Kamino uses external deposit flow");
  }
}

