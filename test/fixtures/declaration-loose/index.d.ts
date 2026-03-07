export declare function getData(url: string): Promise<any>;
export declare function process(input: any): any;
export declare function transform(data: Record<string, any>): Record<string, any>;

export type Config = Record<string, any>;

export declare function getConfig(): Config;
export declare function setConfig(config: any): void;
