/* Shared mock debate (the 豆腐脑 sweet-vs-salty example from the screenshot,
 * lightly extended to 2 rounds so timeline / arena concepts have a story to show). */
window.DEBATE = {
  form: "正反辩论",
  motion: "甜豆腐脑 vs 咸豆腐脑，哪个才是豆腐脑的正统吃法？",
  stopReason: "已澄清为价值之争",
  brief: {
    leaningSide: "salty",
    leaningTitle: "倾向「咸为正统」",
    leaning:
      "基于现有可考史料与饮食史常识，咸口的论证更扎实：点卤工艺赋予豆腐脑咸的物理底色，且糖的稀缺性使甜口在宋代以前不具备大众基础。咸口与豆腐脑的诞生机制及古代调味现实高度匹配。",
    confidencePct: 65,
    confidenceLevel: "medium",
    confidenceLabel: "中",
    reversal:
      "若未来发现明确记载汉代至唐代存在甜豆腐脑的考古或古籍证据，或证明古代普通百姓能稳定获取廉价甜味剂，则倾向将反转为「甜为正统」。",
    crux:
      "豆腐脑早期调味是甜还是咸？「正统」应基于原初工艺（与点卤共生）还是历史传承（早期文献记载）？",
    valueDisputes: [
      "「正统」应定义为与诞生工艺共生的原初形态（点卤即咸），还是历史上最早被广泛接受并流传的形态？",
      "饮食正统是否应考虑地域多样性（南方甜、北方咸均可视为地域正统）？",
    ],
    recommendation:
      "若你关注「历史本源」，建议采纳咸为正统（点卤即咸、糖稀缺）；若你关注「个人体验」或「地域认同」，按口味自选即可，无所谓正统。多数饮食史学者认为咸卤是豆腐脑的原始形态，甜豆花是蔗糖工业化后的地方创新。",
    factualDisputes: [
      "西汉时期是否有糖（蜂蜜/饴糖）足以支撑甜豆腐脑的大众化？",
      "豆腐脑最早的文字记载（如宋代《清异录》）描述的究竟是甜是咸？",
      "点卤工艺中的卤水是否必然使豆腐脑自带咸味？（现代可用石膏、酸类替代，古代主流是盐卤）",
    ],
    openQuestions: [
      "你心中「正统」的标准是历史起源，还是你自己习惯的口味？",
      "若承认地域差异，是否接受「南北各自为正统」的结论？",
    ],
  },
  sides: [
    {
      key: "sweet",
      name: "豆包",
      stance: "甜党",
      model: "Doubao",
      colorVar: "--agent-sweet",
      point:
        "甜口符合早期豆制品调味逻辑：原始豆腐腥重，用糖中和是自然选择；南方古称「豆腐花」且百年传承甜口，北方咸口是后期作为早餐主食的变异。",
    },
    {
      key: "salty",
      name: "原生 DeepSeek",
      stance: "咸党",
      model: "DeepSeek",
      colorVar: "--agent-salty",
      point:
        "咸豆腐脑点制是其诞生的化学基础（卤水本身咸）；糖在中国古代长期稀缺（蔗糖精制明代才成熟），千余年间大众只能以咸调味，宋代文献也指向咸食传统。",
    },
  ],
  rounds: [
    {
      no: 1,
      focus: "豆腐脑最早是甜还是咸？",
      signal: "quiet",
      summary:
        "双方各自亮出立场：甜党诉诸「中和豆腥 + 南方豆腐花传承」，咸党诉诸「卤水致咸 + 糖稀缺」。尚未正面接火，属开场立论。",
      verdict: {
        real_clash: false,
        new_arguments: true,
        converged: false,
        rationale: "首轮各自立论、未直接反驳，逼出下一轮真交锋。",
      },
      clashes: [],
      speeches: {
        sweet:
          "原始豆腐豆腥味重，先民用糖中和是最自然的选择；南方自古称其为「豆腐花」，甜口百年传承至今，是更早、更稳定的形态。北方的咸口更像是后来把它当早餐主食后的变异。",
        salty:
          "豆腐脑是「点」出来的——卤水（盐卤）本身就是咸的，咸味是诞生时的化学底色。而糖在古代长期是奢侈品，蔗糖精制技术到明代才成熟，千余年间普通人根本无糖可加，只能咸食。",
      },
    },
    {
      no: 2,
      focus: "「正统」该按原初工艺还是历史传承认定？",
      signal: "converged",
      summary:
        "事实层已无新证据：双方都承认「古代糖稀缺、卤水致咸」，分歧收敛为对「正统」二字的价值取向——是看诞生工艺，还是看流传最广的形态。这一步 AI 判不了。",
      verdict: {
        real_clash: true,
        new_arguments: false,
        converged: true,
        rationale:
          "双方在事实层已无新论据，分歧收敛为「正统」定义的价值取向（工艺本源 vs 历史流变），属价值之争，澄清后收场。",
      },
      clashes: [
        {
          from: "salty",
          to: "sweet",
          point: "「豆腐花」的甜口是蔗糖普及后的地方创新，代表不了唐宋以前的原初形态。",
        },
        {
          from: "sweet",
          to: "salty",
          point: "卤水致咸是化学必然，但「正统」应看流传最广、最被接受的形态，而非诞生瞬间的味觉。",
        },
      ],
      speeches: {
        sweet:
          "我承认卤水带咸、古代糖也确实贵。但「正统」不该等于「诞生瞬间的味道」——一种吃法是否正统，要看它在历史里有没有被广泛接受、稳定流传。甜豆腐脑在南方就是这样活下来的。",
        salty:
          "你说的「流传最广」恰恰要靠数据支撑，而我们手上能考的早期文献与工艺都指向咸。所谓甜口传承，更多是明清蔗糖普及后的地方创新——它可以是「地域正统」，但不是「历史本源」。",
      },
    },
  ],
  /* Issue-centric view (used by concept 3 「争点分诊」): one row per contested
   * point, each tagged 事实可判 / 需你拍板 / 仍待解, with both sides' stance. */
  cruxMap: [
    {
      id: "origin-taste",
      q: "豆腐脑最早的调味，是甜还是咸？",
      type: "fact",
      status: "事实层已无新证据",
      sweet: "原始豆腥味重，先民用糖中和最自然；南方自古称「豆腐花」，甜口百年传承。",
      salty: "卤水（盐卤）点制本身即咸，是诞生的化学底色；糖在明代前长期稀缺，大众只能咸食。",
      lean: "salty",
      judge: "现存可考工艺与早期文献更支持咸口；甜口缺少唐宋以前的硬证据，故倾向咸。",
    },
    {
      id: "orthodoxy-def",
      q: "「正统」该按原初工艺，还是历史流传认定？",
      type: "value",
      status: "需你拍板",
      sweet: "正统应看流传最广、最被接受的形态，而非诞生瞬间的味觉。",
      salty: "正统应看与诞生工艺共生的原初形态——点卤即咸。",
      lean: null,
      judge: "这是价值取向之争，AI 判不了：取决于你认「工艺本源」还是「历史流变」。",
    },
    {
      id: "region",
      q: "是否接受「南北各自为正统」的地域多元结论？",
      type: "value",
      status: "需你拍板",
      sweet: "南甜北咸都是地域正统，不必强分高下。",
      salty: "可承认「地域正统」，但它与「历史本源」是两个不同的问题。",
      lean: null,
      judge: "若你接受地域多元，甜咸「谁是正统」之争本身即被消解。",
    },
    {
      id: "sugar-access",
      q: "古代普通人能否稳定获取甜味剂以支撑甜口大众化？",
      type: "open",
      status: "仍待考据",
      sweet: "蜂蜜、饴糖等早有使用，未必只有蔗糖一途。",
      salty: "蔗糖精制到明代才成熟，此前甜味剂昂贵，难以支撑大众日常。",
      lean: null,
      judge: "需更多考古/物价史证据；这是「何时会反转」的关键事实变量。",
    },
  ],
};
