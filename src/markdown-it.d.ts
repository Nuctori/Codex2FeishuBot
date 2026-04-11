declare module 'markdown-it' {
  export default class MarkdownIt {
    constructor(...args: any[]);
    parse(src: string, env?: unknown): any[];
    render(src: string, env?: unknown): string;
    enable(...args: any[]): this;
    disable(...args: any[]): this;
    use(...args: any[]): this;
    block: any;
    inline: any;
    renderer: any;
    utils: any;
  }
}
