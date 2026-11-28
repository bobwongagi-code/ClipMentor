// Distilled from human-teaching-calibration.json and the editor's same-source JUDYDOLL declaration.
// The last three JUDYDOLL writing examples are structural controls, not approved wording.
export const creatorJudgment = [
  '先说画面让人当场看出什么。写清达人下条能改变的一个拍摄选择。',
  '画面示范事实，讲解交代取舍及其作用。让参照、读图落点和停留有任务。',
  '先用本片证据建立判断。范例只借方法，已有编辑确认只在本片证据支持之处沿用。',
] as const;

type Entry = { id: string; payoff: string; why: string; mistake: string; limit: string };
type Card = { title: string; file: string; use: string; entries: Entry[] };
const entry = (id: string, payoff: string, why: string, mistake: string, limit: string): Entry =>
  ({ id, payoff, why, mistake, limit });

export const creatorExemplarCards: Card[] = [
  { title: 'Barely There', file: 'references/creator-barely-there.json', use: '用熟悉对象当透度或比例参照', entries: [entry('BT-02', '看出布拉开时有多透', '熟悉的脸部轮廓提供参照', '只报举起布料', '不能证明长时间穿着体验')] },
  { title: 'Green Makes', file: 'references/creator-green-makes.json', use: '同对象、不同用法的结果对比', entries: [entry('GM-04', '看出同色号薄涂和叠涂的浓淡差', '同一个色号让涂法成为可比较的变化', '只报上嘴与晕开', '不能推广到所有色号')] },
  { title: 'TeaShell', file: 'references/creator-teashell.json', use: '用同屏参照看差异', entries: [entry('TS-05', '同屏看到两手当时的外观差', '共同画面比凭记忆对照更直接', '只报两手依次举起', '不能推出产品因果或长期效果')] },
  { title: 'NIUMO', file: 'references/creator-niumo.json', use: '区分说明、演示与体验', entries: [entry('NM-04', '分清功能说明与现场体验', '先立使用情境，再让不同证据各自承担一项判断', '把触摸过程当功能测试', '体感不证明自动断电或所有手机的温度')] },
  { title: 'JUDYDOLL', file: 'references/creator-judydoll.json', use: '带问题的开场、落点示范和结果收尾', entries: [
    entry('JD-hook', '成绩让人想知道原片做对了什么', '事实建立悬念，前提和问题都说清', '只放数字或解释成交原因', '不继承别片成绩、口播或成交因果'),
    entry('JD-opening-pair', '先看到妆面，再认清双盘对应关系', '前置结果吸引注意，共同参照让两对象可比', '拆成两段动作清单', '并排与妆面都不证明适用色号'),
    entry('JD-application', '跟着不同落点看清工具与部位', '关键示范用可读近景，必要时用总览建立位置', '口播念部位，画面却看不见', '分开的窗口不证明连续刷涂或取粉量'),
    entry('JD-finish', '看到示范后的颊面与轮廓', '避开遮挡，用另一个角度展示结果', '只报转脸或把收尾与开头合成一项', '不推断色号、功效或此前动作的因果'),
    entry('JD-1-C', '知道先亮结果能引出什么具体问题', '随后交代对象和可比关系，解释开场取舍', '把包装、编号与动作逐项念一遍', '开场观感不证明盘色归属'),
    entry('JD-2-E', '知道下条片可怎样精简使用示范', '让关键部位承担当场可见的教学，口播交代取舍', '只说动作发生或靠一张小图总代替', '看不清的部位、用量留待核对'),
    entry('JD-3-B', '学到如何让实际妆面在示范之后可读', '给观众观察颊面和轮廓的时机', '结尾只说她动了脸', '观察结果不证明用色或适配'),
  ] },
];
