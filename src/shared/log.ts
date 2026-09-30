/**
 * 日志行里「这行是谁写的」的判据。
 *
 * 日志缓冲里混着两种行：
 *  - **被监控进程的真实输出**（stdout / stderr 合并过来的）
 *  - **terminal-manage 自己插的提示**：启动横幅、退出提示、端口警告、终止通知
 *
 * 大部分地方不需要区分（用户就是按时间顺序看），但**链接提取必须区分**：
 * 启动横幅会把命令行原样回显，于是命令行文本里自带的地址 —— `curl http://内网/health`、
 * `vite --host http://…` 这类 —— 会被当成「这条命令暴露的链接」混进卡片的下拉里，
 * 用户点开看到的是一个根本没人监听的地址。
 *
 * 抽成共享常量的理由：渲染层要按它过滤，主进程要按它生成。两边各自写一遍字面量
 * 的话，改前缀时必然有一边悄悄失效 —— 而且失效是静默的（下拉里多几条假链接，
 * 没有任何报错）。
 */
export const META_PREFIX = '[terminal-manage]'

/** 这一行是不是 terminal-manage 自己插的提示（而不是被监控进程的输出） */
export function isMetaLine(text: string): boolean {
  return text.startsWith(META_PREFIX)
}
