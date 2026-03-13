import { BaseProtocol } from "./BaseProtocol";

export class AptreeProtocol implements BaseProtocol {
  name = "APTree";

  async buildDeposit(amountOctas: bigint): Promise<{
    type: "entry_function_payload";
    function: string;
    type_arguments: string[];
    arguments: string[];
  }> {
    return {
      type: "entry_function_payload",
      function:
        "0x951a31b39db54a4e32af927dce9fae7aa1ad14a1bb73318405ccf6cd5d66b3be::bridge::deposit",
      type_arguments: [],
      arguments: [amountOctas.toString(), "0"],
    };
  }
}
