// Distilled from human-teaching-calibration.json and the editor's same-source JUDYDOLL declaration.
// The last three JUDYDOLL writing examples are structural controls, not approved wording.
export const creatorJudgment = [
  '先说画面让人当场看出什么。写清达人下条能改变的一个拍摄选择。',
  '画面示范事实，讲解交代取舍及其作用。让参照、读图落点和停留有任务。',
  '先用本片证据建立判断。范例只借方法，已有编辑确认只在本片证据支持之处沿用。',
] as const;

type Dimension = 'relationship' | 'evidence_boundary' | 'copy_form' | 'picture_support' | 'opening' | 'stage_visual';
type JudgmentLayer = 'code' | 'reader' | 'human';
type Anchor = {
  version: string;
  viewed: readonly ('blueprint' | 'edit' | 'full_film')[];
  strength: 'strong' | 'medium' | 'weak';
  basis: string;
  confirmation: string;
};
type Entry = { basis?: string; writingControl?: true; id: string; payoff: string; why: string; mistake: string; limit: string; dimension: Dimension; layers: readonly JudgmentLayer[] };
type Card = { title: string; file: string; use: string; anchor: Anchor; entries: Entry[] };
const entry = (id: string, payoff: string, why: string, mistake: string, limit: string,
  dimension: Dimension = 'relationship', layers: readonly JudgmentLayer[] = ['reader']): Entry =>
  ({ id, payoff, why, mistake, limit, dimension, layers });

const editor = '项目编辑确认已看过所列范围';
const reviewedEdit = ['blueprint','edit'] as const;

export const creatorExemplarCards: Card[] = [
  { title: 'Barely There', file: 'references/creator-barely-there.json', use: '用熟悉对象当透度或比例参照',
    anchor: {version:'新建联预览',viewed:reviewedEdit,strength:'weak',basis:'C1 新建联预览及阶段工程冷读',confirmation:editor}, entries: [
      entry('BT-02', '看出布拉开时有多透', '熟悉的脸部轮廓提供参照', '只报举起布料', '不能证明长时间穿着体验'),
      entry('BT-source-invitation', '听懂原作者把可见做工怎样接到购买提示', '先让细节可看，再说明原片中数量和行动入口的作用', '把推荐数量写成实物套装，或混入自己的达人邀请', '不补造按钮、新优惠或承诺', 'evidence_boundary'),
      {...entry('BT-still-focus', '停留时看清面料与脸部参照或衬片边缘', '目标可读时用跟随对应句的标注，随后恢复动态', '只停画面或拿冻结补声长', '工程标注不证明实际声音对位', 'picture_support',['code','human']),
        basis:'旧蓝图的读图计划可参考。新建联预览主体没有独立静帧图层。'},
    ] },
  { title: 'Green Makes', file: 'references/creator-green-makes.json', use: '同对象、不同用法的结果对比',
    anchor: {version:'已合作 r20',viewed:reviewedEdit,strength:'strong',basis:'r20 成片工程冷读 source_breakdown.points 与当前文案',confirmation:'项目编辑确认定稿'}, entries: [
      entry('GM-P01', '先看到唇妆和沾染关注为什么值得继续看', '把买家关心的可见预告放在介绍前', '只念包装或将预告讲成全天效果', '不能归因留存或销量','opening',['reader']),
      entry('GM-P02', '理解一个具体妆效怎样引出所介绍的产品', '先给理由，再让商品出现在讲述旁', '只重复品牌或动作', '原作者的经历不等于已证实的事实','copy_form'),
      {...entry('GM-P03', '先用同色的两种浓淡建立判断，再看其他选项', '一次变化提供共同参照', '分别报涂法与颜色选项却不交代关系', '不能跨时刻拼假同框或断言每色同效'),
        basis:'r20 口播确认同色的浓淡，后续颜色选择由来源台账与独立抽样支持'},
      entry('GM-04', '看出同色号薄涂和叠涂的浓淡差', '同一个色号让涂法成为可比较的变化', '只报上嘴与晕开', '不能推广到所有色号'),
      entry('GM-P04', '看到接触前后如何检查沾色', '保留嘴唇接触、拿开及可见结果', '只举杯或切掉结果', '杯中看不清的水不能写为已证实，也不能替全天认证','evidence_boundary'),
      {...entry('GM-P05', '用同手同框把几个颜色放在共同肤色下比较', '同一画面让观众保留参照', '跨时刻拼成同时，或附会是单变量实测', '不证明只有色号这个变量在变化'),
        basis:'r20 由原画面和短标承担，无独立现行口播'},
      entry('GM-P06', '认出早段优惠如何在最后接到原片购买入口', '用同组商品呼应片中数量，再交代原指向', '把我们的达人邀请混作原作者促单', '不推出赠品色号或现行报价','relationship'),
      entry('GM-stage-read', '一眼分清原片和讲解承担不同任务', '阶段样式统一，细节用实际片段和随句提示呈现', '阶段名称盖住证据或只靠颜色区分', '历史色值不作通用标准','stage_visual',['code','human']),
    ] },
  { title: 'TeaShell', file: 'references/creator-teashell.json', use: '用同屏参照看差异',
    anchor: {version:'后续两段预览 v4',viewed:reviewedEdit,strength:'medium',basis:'代表段深化 v4-r2，肘部与两手背两段',confirmation:editor}, entries: [
      entry('TS-elbow', '先辨认见到的是哪个部位，再读局部', '定位画面给随后近景一个空间参照', '只给一个读不懂位置的近裁', '不推出处理状态或肤色变化因果','picture_support',['reader','human']),
      entry('TS-05', '同屏看到两手当时的外观差', '共同画面比凭记忆对照更直接', '只报两手依次举起', '不能推出产品因果或长期效果'),
    ] },
  { title: 'NIUMO', file: 'references/creator-niumo.json', use: '区分说明、演示与体验',
    anchor: {version:'V7 已合作第 1 组',viewed:reviewedEdit,strength:'medium',basis:'V7 已合作工程和第 1 组审核，双版本剪辑只供测量',confirmation:editor}, entries: [
      entry('NM-situation', '理解夜间充电为何引出产品的功能说明', '先提供实际使用情境，让原片说明有具体对象', '先报功能结果再倒推实测', '画面文字不认证实际自动断电','copy_form'),
      entry('NM-04', '分清功能说明与现场体验', '先立使用情境，再让不同证据各自承担一项判断', '把触摸过程当功能测试', '体感不证明自动断电或所有手机的温度','evidence_boundary'),
      entry('NM-hold', '看清当句点名的触摸对象', '在对应回看中让近景或标注承担读图任务', '箭头标到无关区域或把过场静帧当联系方式', '标注不能补出原片没有的测量','picture_support',['reader','human']),
    ] },
  { title: 'JUDYDOLL', file: 'references/creator-judydoll.json', use: '带问题的开场、落点示范和结果收尾',
    anchor: {version:'v3-57b78e4e',viewed:['blueprint'],strength:'strong',basis:'三组已确认决定与同源回放',confirmation:'用户确认三组与同源实验标尺'}, entries: [
    entry('JD-hook', '成绩让人想知道原片做对了什么', '事实建立悬念，前提和问题都说清', '只放数字或解释成交原因', '不继承别片成绩、口播或成交因果','opening',['code','reader']),
    entry('JD-opening-pair', '先看到妆面，再认清双盘对应关系', '前置结果吸引注意，共同参照让两对象可比', '拆成两段动作清单', '并排与妆面都不证明适用色号'),
    entry('JD-application', '跟着不同落点看清工具与部位', '关键示范用可读近景，必要时用总览建立位置', '口播念部位，画面却看不见', '分开的窗口不证明连续刷涂或取粉量'),
    entry('JD-finish', '看到示范后的颊面与轮廓', '避开遮挡，用另一个角度展示结果', '只报转脸或把收尾与开头合成一项', '不推断色号、功效或此前动作的因果'),
    entry('JD-1-C', '知道先亮结果能引出什么具体问题', '随后交代对象和可比关系，解释开场取舍', '把包装、编号与动作逐项念一遍', '开场观感不证明盘色归属'),
    entry('JD-2-E', '知道下条片可怎样精简使用示范', '让关键部位承担当场可见的教学，口播交代取舍', '只说动作发生或靠一张小图总代替', '看不清的部位、用量留待核对','picture_support',['code','reader']),
    entry('JD-3-B', '学到如何让实际妆面在示范之后可读', '给观众观察颊面和轮廓的时机', '结尾只说她动了脸', '观察结果不证明用色或适配'),
  ] },
];

export const creatorExemplars = new Map(creatorExemplarCards.flatMap(({anchor,entries}) => entries.map(item =>
  [item.id, {...item, ...(item.id==='JD-1-C'||item.id==='JD-2-E'||item.id==='JD-3-B'?{writingControl:true as const}:{}), anchor, file: `references/creator-exemplar-${item.id}.json`}] as const)));

export const legacyCreatorExamples = new Set(['BT-02','GM-04','TS-05','NM-04','JD-hook','JD-opening-pair','JD-application','JD-finish','JD-1-C','JD-2-E','JD-3-B']);
