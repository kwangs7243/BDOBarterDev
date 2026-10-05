const MODES = ["none", "inner", "ocean", "t7_2region", "t7_2region_south", "t7_2region_arehazaX", "t7_3region"];
const MODE_LABELS = { none: "📦 일반 (까주 미포함)", inner: "📦+💰 내해 까주 포함", ocean: "📦+🌊 대양 까주 포함", t7_2region: "🔥 2지역 7단 (그란X)", t7_2region_south: "🌊 2지역 7단 (해모X)", t7_2region_arehazaX: "🌸 2지역 7단 (아레하자X)", t7_3region: "🚀 3지역 7단" };
const MODE_SELECT_LABELS = { none: "[초보] 재고(까주X)", inner: "[중수] 재고+내해까주", ocean: "[고수] 재고+대양까주", t7_2region: "[고인물] 7단 2지역(그란X)", t7_2region_south: "[고인물] 7단 2지역(해모X)", t7_2region_arehazaX: "[고인물] 7단 2지역(아레X)", t7_3region: "[해골물] 7단 3지역" };
const TUNING_FIELDS = [
  ["specialMatPriority", "특수 재료 우선도", "integer"], ["crowCoinPriority", "까마귀주화 우선도", "integer"],
  ["pathEfficiencyBonus", "경로 효율 보너스", "integer"], ["smallTradePenalty", "소량 교환 페널티", "integer"],
  ["chainMaxDistance", "연속 경로 최대 거리", "integer"], ["chainBonusScore", "연속 경로 보너스", "integer"],
  ["distancePenaltyWeight", "거리 페널티 가중치", "number"], ["overloadPenalty", "과적 페널티", "number"],
  ["efficiencyThreshold", "효율 임계값", "integer"], ["iliyaPitstopRadius", "일리야 경유 반경", "integer"],
  ["overloadTimeWeight", "과적 시간 가중치", "number"], ["deficitRatioBonus", "부족 비율 보너스", "integer"],
  ["emergencyBonus", "긴급 보너스", "integer"], ["preservationBonus", "보존 보너스", "integer"],
  ["westBias", "서쪽 편향", "integer"], ["useClustering", "군집 가중치 (숫자)", "integer"]
];
const PANEL_IDS = ["mainPanel", "slotPanel", "routeListPanel", "coordChangesPanel", "memoListPanel", "routeCalibrationPanel"];
const EMPTY_SESSION_STATE = Object.freeze({ scannedTrades: null, schedule: null, completed: null, remainingParley: null, timers: null, selection: null, drag: null });

let APP_CONFIG = {
    // 💰 교섭력 기본 세팅 (박사님 맞춤형)
    PARLEY_PER_TRADE: 10973, 
    CROW_PARLEY: 15962, 
    
    // ⚖️ 물리/항해 엔진 (배속 170, 과적 페널티 1.6)
    OVERLOAD_PENALTY: 1.6, 
    SHIP_SPEED: 170, 
    OVERLOAD_TIME_WEIGHT: 1.5,
    
    // 🎯 가점 및 집착도 엔진
    SPECIAL_MAT_PRIORITY: 80000, 
    CROW_COIN_PRIORITY: 30000, 
    CHAIN_BONUS_SCORE: 10000,
    PATH_EFFICIENCY_BONUS: 20000, 
    DEFICIT_RATIO_BONUS: 10000, 
    EMERGENCY_BONUS: 10000, 
    PRESERVATION_BONUS: 10000,
    
    // 🛡️ 페널티 및 제한 엔진
    DISTANCE_PENALTY_WEIGHT: 4, 
    SMALL_TRADE_PENALTY: 20000,   
    USE_CLUSTERING: 20000, 
    
    // 📏 반경(Radius) 절대 통제 (박사님 최적화 값)
    CHAIN_MAX_DISTANCE: 100, 
    EFFICIENCY_THRESHOLD: 100, 
    ILIYA_PITSTOP_RADIUS: 599, 
    
    // ⭐ 티어별 기초 가점 (0, 2000, 2900, 4500, 8000)
    TIER_PRIORITY: { T1: 0, T2: 2000, T3: 2900, T4: 4500, T5: 8000 },
    
    // 🌊 기타 시스템 변수
    ALLOW_OCEAN: 'inner', 
    OCEAN_ROUTE: 'auto', 
    WEST_BIAS: 10,
    WEIGHT: { T1: 100, T2: 400, T3: 900, T4: 1000, T5: 1000, T6: 2000, T7: 2000, MAT: 0, COIN: 0, BASE: 10 },
    TRADE_RULES: { T2: { req: 1, get: 3 }, T3: { req: 1, get: 3 }, T4: { req: 1, get: 2 }, T5: { req: 1, get: 1 }, T6: { req: 1, get: 1 }, T7: { req: 1, get: 1 } },
    MULTIPLIER: { DEFAULT: 1, T2: 3, T3: 3, T4: 2 }
};
const masterData = {
    0: [
        { name: "대추야자", weight: 0.1 },
        { name: "영롱한 흑요석", weight: 0.3 },
        { name: "닭고기", weight: 0.03 },
        { name: "어둠의 가루", weight: 0.1 },
        { name: "세월의 가루", weight: 0.1 },
        { name: "영롱한 비취", weight: 0.3 },
        { name: "호랑이 고기", weight: 0.03 },
        { name: "이끼나무 합판", weight: 0.5 },
        { name: "삼나무 합판", weight: 0.5 },
        { name: "상급 화려한 깃털", weight: 0.1 },
        { name: "두꺼운 모피", weight: 0.1 },
        { name: "상급 단단한 가죽", weight: 0.1 },
        { name: "현자의 혈액", weight: 0.1 },
        { name: "가시나무 합판", weight: 0.5 },
        { name: "양털", weight: 0.1 },
        { name: "편백나무 합판", weight: 0.5 },
        { name: "무화과", weight: 0.1 },
        { name: "울", weight: 0.1 },
        { name: "구리 주괴", weight: 0.3 },
        { name: "최상급 곰 가죽", weight: 0.1 },
        { name: "최상급 멧돼지 가죽", weight: 0.1 },
        { name: "소나무 합판", weight: 0.5 },
        { name: "핏빛 나무 옹이", weight: 0.1 },
        { name: "상급 두꺼운 모피", weight: 0.1 },
        { name: "청동 주괴", weight: 0.3 },
        { name: "고리나무 합판", weight: 0.5 },
        { name: "계피", weight: 0.1 },
        { name: "팔각", weight: 0.1 },
        { name: "맑은 액체 시약", weight: 0.1 },
        { name: "화각", weight: 0.1 },
        { name: "질긴 가죽", weight: 0.1 },
        { name: "황동 주괴", weight: 0.3 },
        { name: "육두구", weight: 0.1 },
        { name: "맥주", weight: 0.1 },
        { name: "식초", weight: 0.01 },
        { name: "측백나무 합판", weight: 0.5 },
        { name: "균열의 가루", weight: 0.1 },
        { name: "납 주괴", weight: 0.3 },
        { name: "주석 주괴", weight: 0.3 },
        { name: "야자수 합판", weight: 0.5 },
        { name: "알로에", weight: 0.1 },
        { name: "단풍나무 합판", weight: 0.5 },
        { name: "새구이", weight: 0.1 },
        { name: "신비로운 가루", weight: 0.1 },
        { name: "부드러운 가죽", weight: 0.1 },
        { name: "죄인의 혈액", weight: 0.1 },
        { name: "신수의 혈액", weight: 0.1 },
        { name: "순수한 가루 시약", weight: 0.1 },
        { name: "명주실", weight: 0.1 },
        { name: "술의 정수", weight: 0.01 },
        { name: "전나무 합판", weight: 0.5 },
        { name: "선인장 껍질", weight: 0.5 },
        { name: "피스타치오", weight: 0.1 },
        { name: "털실", weight: 0.1 },
        { name: "식용벌꿀", weight: 0.1 },
        { name: "자작나무 합판", weight: 0.5 },
        { name: "프리카", weight: 0.1 },
        { name: "비단", weight: 0.1 },
        { name: "아마포", weight: 0.1 },
        { name: "코코넛", weight: 0.1 },
        { name: "빛나는 가루", weight: 0.1 },
        { name: "딱총나무 합판", weight: 0.5 },
        { name: "다진 새고기", weight: 0.03 },
        { name: "면포", weight: 0.1 },
        { name: "광대의 혈액", weight: 0.1 },
        { name: "가공석탄", weight: 0.3 },
        { name: "선인장 가시", weight: 0.5 },
        { name: "철 주괴", weight: 0.3 },
        { name: "고목나무 껍질", weight: 0.1 },
        { name: "비취 원석", weight: 0.3 },
        { name: "상급 질긴 가죽", weight: 0.1 },
        { name: "가벼운 깃털", weight: 0.1 },
        { name: "호박", weight: 0.1 },
        { name: "아마실", weight: 0.1 },
        { name: "설원 삼나무 합판", weight: 0.5 },
        { name: "카프라스 나무 합판", weight: 0.5 },
        { name: "아연 주괴", weight: 0.3 },
        { name: "녹 주괴", weight: 0.3 },
        { name: "단단한 가죽", weight: 0.1 },
        { name: "상급 부드러운 가죽", weight: 0.1 },
        { name: "화려한 깃털", weight: 0.1 },
        { name: "상급 가벼운 깃털", weight: 0.1 },
        { name: "정령의 잎사귀", weight: 0.1 },
        { name: "붉은 나무혹", weight: 0.1 },
        { name: "화염의 가루", weight: 0.1 },
        { name: "대지의 가루", weight: 0.1 }
    ],
    1: [{ name: "갈퀴 꽃 씨앗 주머니", stock: 21 }, { name: "거대한 물고기 뼈", stock: 47 }, { name: "고대 항아리 파편", stock: 32 }, { name: "때 탄 갈매기 조각상", stock: 34 }, { name: "뗏목 조각품", stock: 53 }, { name: "로아 꽃 씨앗 주머니", stock: 20 }, { name: "말린 푸른 장미", stock: 50 }, { name: "비옥한 흙", stock: 33 }, { name: "알 수 없는 고대 벽화", stock: 38 }, { name: "앵두나무 씨앗 주머니", stock: 54 }, { name: "쫄깃한 전어 회", stock: 34 }, { name: "해상 전투 식량", stock: 59 }, { name: "해적의 화약", stock: 21 }, { name: "황금빛 모래", stock: 49 }],
    2: [{ name: "괴생물 촉수", stock: 0 }, { name: "균형잡힌 돌탑", stock: 13 }, { name: "나르보산 해삼", stock: 93 }, { name: "널찍한 돌판", stock: 72 }, { name: "섬마을 도시락", stock: 38 }, { name: "성게 가시", stock: 31 }, { name: "소라게 껍질 장식", stock: 47 }, { name: "오색 구슬", stock: 30 }, { name: "정제된 식수", stock: 33 }, { name: "최고급 굴 상자", stock: 65 }, { name: "크론성 금주화", stock: 42 }, { name: "해양 구조품", stock: 66 }, { name: "해적 금주화", stock: 86 }, { name: "해적선 돛대", stock: 101 }],
    3: [{ name: "걸쭉한 괴생물 혈액", stock: 44 }, { name: "낡은 지령서", stock: 30 }, { name: "롬타스 그물", stock: 60 }, { name: "반달 조리용 칼", stock: 41 }, { name: "오래된 모래 시계", stock: 39 }, { name: "정찰병 망원경", stock: 41 }, { name: "족제비 가죽 외투", stock: 37 }, { name: "종유석 파편", stock: 47 }, { name: "찢어진 해적 보물지도", stock: 16 }, { name: "푸른 양초 더미", stock: 38 }, { name: "해골 장식 찻잔", stock: 45 }, { name: "해골무늬 카페트", stock: 38 }, { name: "해적단의 보급상자", stock: 62 }, { name: "희귀 약초 무더기", stock: 42 }],
    4: [{ name: "굳어진 용암 액", stock: 30 }, { name: "금주화가 담긴 낡은 상자", stock: 30 }, { name: "만병통치약", stock: 0 }, { name: "목 잘린 용 조각상", stock: 25 }, { name: "뱃사공의 수련서", stock: 38 }, { name: "오색빛 실타래", stock: 32 }, { name: "자수정 파편", stock: 38 }, { name: "조개 껍질 장식", stock: 31 }, { name: "청동 촛대", stock: 30 }, { name: "청록빛 소금덩어리", stock: 24 }, { name: "해상 기사단의 창", stock: 32 }, { name: "해상 기사단의 투구", stock: 15 }, { name: "해적의 열쇠", stock: 32 }, { name: "훔친 해적단 단도", stock: 19 }],
    5: [{ name: "정체불명의 암석", stock: 2 }, { name: "팔각 문양 보관함", stock: 2 }, { name: "푸른빛 석영", stock: 15 }, { name: "102년 묵은 황금초", stock: 0 }, { name: "37년된 약주", stock: 0 }, { name: "고급 문양의 옷감", stock: 0 }, { name: "고대인을 형상화한 초상화", stock: 0 }, { name: "빛바랜 황금용 조각상", stock: 0 }, { name: "젊음을 담은 비약", stock: 0 }, { name: "조각상의 눈물", stock: 0 }, { name: "최고급 황금 촛대", stock: 0 }, { name: "팔랑나비 박제품", stock: 0 }, { name: "황금빛 물고기 비늘", stock: 0 }, { name: "흰색 애벌레 박제품", stock: 0 }],
    6: [
        { name: "발렌시아 모래 방패", stock: 0 }, { name: "발렌시아 사막 보검", stock: 0 }, { name: "화려한 낙타 가죽", stock: 0 }, { name: "황금 사막의 모래반지", stock: 0 },
        { name: "최고급 코코넛 시럽", stock: 0 }, { name: "아레하자 전통 차", stock: 0 }, { name: "아레하자 등대 조각상", stock: 0 }, { name: "황금빛 선인장 꽃다발", stock: 0 },
        { name: "숲의 요정 향수병", stock: 0 }, { name: "카마실비아 조각상", stock: 0 }, { name: "달빛 수정 램프", stock: 0 }, { name: "은빛 나무 이끼 장식", stock: 0 },
        { name: "검은 장미 꽃다발", stock: 0 }, { name: "월광 수정 조각", stock: 0 }, { name: "달빛 그림자 숙성 와인", stock: 0 }, { name: "그림자 장식 거울", stock: 0 },
        { name: "대나무 수액 상자", stock: 0 }, { name: "남포 특산품 감 상자", stock: 0 }, { name: "고급 묵향함", stock: 0 }, { name: "한짓골 산딸기 상자", stock: 0 },
        { name: "최고급 청화백자 상자", stock: 0 }, { name: "최고급 감투 상자", stock: 0 }, { name: "놋쇠그릇 상자", stock: 0 }, { name: "예리한 홍화도 상자", stock: 0 }
    ],
    7: [
        { name: "최고급 하이델산 포도주", stock: 0 }, { name: "금빛 밀가루 포대", stock: 0 }, { name: "유기농 벌꿀 상자", stock: 0 }, { name: "발레노스 전통 닻 장식", stock: 0 },
        { name: "황금 독수리 브로치", stock: 0 }, { name: "칼페온 기사단의 전투 교본", stock: 0 }, { name: "칼페온 황금 장식 촛대", stock: 0 }, { name: "칼페온 장인의 진주 목걸이", stock: 0 },
        { name: "소산 군수품 상자", stock: 0 }, { name: "돌꼬리 당근 건강식 상자", stock: 0 }, { name: "오마르 용암 가루", stock: 0 }, { name: "타리프의 마법 항아리", stock: 0 },
        { name: "루살카 가시꽃다발", stock: 0 }, { name: "단단한 카프라스 목재", stock: 0 }, { name: "하킨자 최고급 향수", stock: 0 }, { name: "에다나 권좌의 기록서", stock: 0 },
        { name: "장인의 조개 껍질 목걸이", stock: 0 }, { name: "발레노스 항해사의 망원경", stock: 0 }, { name: "발레노스 고래 조각상", stock: 0 }, { name: "발레노스 소금꽃", stock: 0 },
        { name: "발레노스 별빛 소금", stock: 0 }, { name: "발레노스 유물 파편", stock: 0 }, { name: "발레노스 무지개 산호", stock: 0 }, { name: "무지개빛 해원석 조각", stock: 0 }
    ],
    mat: [
        { name: "순수한 진주 결정", weight: 0.30 },
        { name: "화려한 진주 결정", weight: 0.10 },
        { name: "화려한 암염 주괴", weight: 0.30 },
        { name: "빛나는 코발트 주괴", weight: 0.30 },
        { name: "오킬루아의 꽃", weight: 0 },
        { name: "파도의 블랙스톤", weight: 0.01 },
        { name: "대양의 견고한 현철", weight: 0.30 },
        { name: "유실된 무역품 상자", weight: 50 }
    ]
};
const rawData = {
    "달래나루": {"x": -2471, "y": 2682},
    "해모 섬": {"x": -3261, "y": 1751}, "해모": {"x": -3261, "y": 1751},
    "그란디하": {"x": -2524, "y": -1534},
    "깊은 밤의 항구": {"x": -3049, "y": -1975}, "깊은 밤": {"x": -3049, "y": -1975},
    "올비아 해안": {"x": -519, "y": -440},
    "에페리아 초소": {"x": -1424, "y": -525},
    "소산 주둔지 선착장": {"x": 241, "y": -356}, "소산 선착장": {"x": 241, "y": -356}, "소산 주둔지": {"x": 241, "y": -356},
    "성전 해안 정찰지": {"x": 1026, "y": 486}, "성전 해안": {"x": 1026, "y": 486},
    "테야말 섬": {"x": -1714, "y": -555}, "라메다 섬": {"x": -1685, "y": -337},
    "시오닐 섬": {"x": -1750, "y": -550}, "모드릭 섬": {"x": -1576, "y": -476},
    "바에자 섬": {"x": -1500, "y": -509}, "진버레이 섬": {"x": -1534, "y": -343},
    "데이튼 섬": {"x": -1550, "y": -300}, "네트넘 섬": {"x": -1451, "y": -235},
    "오벤 섬": {"x": -1389, "y": -198}, "던데 섬": {"x": -1357, "y": -271},
    "에버딘 섬": {"x": -1307, "y": -246}, "알브레서 섬": {"x": -1232, "y": -287},
    "바라테르 섬": {"x": -1217, "y": -353}, "란디스 섬": {"x": -1364, "y": -442},
    "세르카 섬": {"x": -1370, "y": -503}, "테스테 섬": {"x": -1457, "y": 49},
    "알마이 섬": {"x": -1377, "y": 123}, "쿠이트 제도": {"x": -1276, "y": 238},
    "파딕스 섬": {"x": -1276, "y": 205}, "아리타 섬": {"x": -1011, "y": 127},
    "리스즈 섬": {"x": -991, "y": -49}, "스타렌 섬": {"x": -1025, "y": -198},
    "루루브 섬": {"x": -935, "y": -129}, "나르보 섬": {"x": -862, "y": 20},
    "마르카 섬": {"x": -857, "y": -101}, "타슈 섬": {"x": -703, "y": 367},
    "레마 섬": {"x": -533, "y": 278}, "인버넨 섬": {"x": -709, "y": 44},
    "앙쥬 섬": {"x": -727, "y": -122}, "툴루 섬": {"x": -615, "y": 100},
    "발베쥬 섬": {"x": -631, "y": -50}, "에베토 섬": {"x": -612, "y": -162},
    "두흐 섬": {"x": -638, "y": -197}, "마를레느 섬": {"x": -558, "y": -54},
    "오르프스 섬": {"x": -538, "y": 110}, "마리베노 섬": {"x": -460, "y": -156},
    "루이바노 섬": {"x": -508, "y": -263}, "에프데 룬 섬": {"x": -379, "y": -305},
    "바레미 섬": {"x": -377, "y": 2}, "웨이타 섬": {"x": -301, "y": -83},
    "파라타마 섬": {"x": -285, "y": -196}, "베이루와 섬": {"x": -182, "y": -308},
    "칸베라 섬": {"x": -190, "y": -113}, "아라킬 섬": {"x": -152, "y": -161},
    "오스트라 섬": {"x": -39, "y": -193}, "타라무라 섬": {"x": -73, "y": -248},
    "델링하트 섬": {"x": 124, "y": -219}, "필바라 섬": {"x": 248, "y": -240},
    "푸자라 섬": {"x": 256, "y": 25}, "아지르 섬": {"x": -206, "y": 97},
    "알나하 섬": {"x": -304, "y": 215}, "라시드 섬": {"x": -222, "y": 309},
    "알 수 없는 섬": {"x": 232, "y": -359}, "소코타 섬": {"x": 435, "y": -373},
    "리에드 섬": {"x": 596, "y": -267}, "에스파 섬": {"x": 671, "y": -121},
    "티그리스 섬": {"x": 630, "y": -69}, "시르나 섬": {"x": 732, "y": -60},
    "오리샤 섬": {"x": 659, "y": 95}, "보아 섬": {"x": 665, "y": 219},
    "로즈반 섬": {"x": 384, "y": 323}, "샤샤 섬": {"x": 275, "y": 321},
    "포르타넨 섬": {"x": 339, "y": 448}, "레라오 섬": {"x": 285, "y": 591},
    "틴베라 섬": {"x": 152, "y": 615}, "할마드 섬": {"x": 1059, "y": 162},
    "카슈마 섬": {"x": 1096, "y": 222}, "더코 섬": {"x": 1679, "y": 225},
    "벨리아 마을 해변": {"x": -397, "y": -502},
    "오킬루아의 눈": {"x": -609, "y": 824},
    "까마귀의 둥지": {"x": 213, "y": 1037},
    "하코번 섬": {"x": 2779, "y": 790},
    "안카도 내항": {"x": 2076, "y": 143},
    "아레하자 마을": {"x": 3383, "y": 1657},
    "일리야": {"x": 0, "y": 0},
    "떠내려온 미완성 선박": {"x": -1827, "y": 2444, "isOcean": true},
    "그믐달 길드의 중범선": {"x": -2137, "y": 1915, "isOcean": true},
    "난파된 하란의 수송선": {"x": -1704, "y": 1590, "isOcean": true},
    "파키오의 전투 뗏목": {"x": -690, "y": 2208, "isOcean": true},
    "랑티니아의 전투 뗏목": {"x": -1566, "y": 2178, "isOcean": true},
    "난파된 콕스해적선": {"x": -1821, "y": 358, "isOcean": true},
    "난파된 해상군의 배": {"x": -2225, "y": 550, "isOcean": true},
    "난파된 릭쿤의 배": {"x": -1921, "y": 861, "isOcean": true},
    "난파된 고대 유적 수송선": {"x": -1620, "y": 1136, "isOcean": true},
    "까마귀 상단 소유의 선박": {"x": -1282, "y": 1379, "isOcean": true},
    "숄라스 치코의 해적 연합": {"x": -2034, "y": 1450, "isOcean": true},
    "떠돌이 상인의 배": {"x": -1314, "y": 1858, "isOcean": true}
};
const islandCoordinates = JSON.parse(JSON.stringify(rawData));
const defaultRouteCalibrations = {
    "안카도 내항_하코번 섬": { multiplier: 1.23809523809524 },
    "하코번 섬_아레하자 마을": { multiplier: 0.938461538461538 },
    "아레하자 마을_에페리아 초소": { multiplier: 1.12684729064039 },
    "에페리아 초소_올비아 해안": { multiplier: 1.07142857142857 },
    "올비아 해안_일리야": { multiplier: 1.05263157894737 },
    "일리야_하코번 섬": { multiplier: 0.877390326209224 },
    "하코번 섬_올비아 해안": { multiplier: 1.01108033240997 },
    "파키오의 전투 뗏목_랑티니아의 전투 뗏목": { multiplier: 0.703703703703704 },
    "랑티니아의 전투 뗏목_떠내려온 미완성 선박": { multiplier: 0.652173913043478 },
    "떠내려온 미완성 선박_그믐달 길드의 중범선": { multiplier: 0.661375661375661 },
    "그믐달 길드의 중범선_난파된 하란의 수송선": { multiplier: 0.838323353293413 },
    "까마귀 상단 소유의 선박_난파된 릭쿤의 배": { multiplier: 0.869565217391304 },
    "해모 섬_달래나루": { multiplier: 1.1436170212766 },
    "성전 해안 정찰지_소산 주둔지 선착장": { multiplier: 0.790960451977401 }
};
const REGION_MAP = {
    WEST: ["테야말", "바에자", "모드릭", "시오닐", "라메다", "진버레이", "세르카", "란디스", "던데", "데이튼", "오벤", "알브레서", "바라테르", "테스테", "알마이", "파딕스", "쿠이트", "아리타", "스타렌", "리스즈", "루루브", "나르보"],
    NORTH: ["틴베라", "레라오", "포르타넨", "샤샤", "로즈반", "알나하", "아지르", "라시드"],
    EAST: ["보아", "오리샤", "티그리스", "시르나", "에스파", "리에드", "소코타"],
    NEAR_WEST: ["앙쥬", "타슈", "툴루", "오르프스", "발베쥬", "마를레느", "에베토", "두흐", "투흐", "루이바노", "마리베노", "에프데 룬", "에프데룬", "파라타마", "베이루와", "타라무라", "오스트라", "아라킬", "칸베라", "웨이타", "바레미"],
    NEAR_EAST: ["필바라", "푸자라"]
};

let routeCalibrations = { ...defaultRouteCalibrations };
window.BDO_CONSTANTS = { MODES, MODE_LABELS, MODE_SELECT_LABELS, TUNING_FIELDS, PANEL_IDS, EMPTY_SESSION_STATE };
window.APP_CONFIG = APP_CONFIG;
window.masterData = masterData;
window.islandCoordinates = islandCoordinates;
window.REGION_MAP = REGION_MAP;
window.applyBdoPersistentConfig = (settings) => {
  const config = settings || {};
  const ship = config.ship || {};
  const parley = config.parley || {};
  const tuning = config.tuning || {};
  const navigation = config.navigation || {};
  if (ship.speed !== undefined) APP_CONFIG.SHIP_SPEED = ship.speed;
  if (ship.mode !== undefined) APP_CONFIG.ALLOW_OCEAN = ship.mode;
  if (parley.normalCost !== undefined) APP_CONFIG.PARLEY_PER_TRADE = parley.normalCost;
  if (parley.crowCost !== undefined) APP_CONFIG.CROW_PARLEY = parley.crowCost;
  const mappings = {
    specialMatPriority: "SPECIAL_MAT_PRIORITY", crowCoinPriority: "CROW_COIN_PRIORITY",
    pathEfficiencyBonus: "PATH_EFFICIENCY_BONUS", smallTradePenalty: "SMALL_TRADE_PENALTY",
    chainMaxDistance: "CHAIN_MAX_DISTANCE", chainBonusScore: "CHAIN_BONUS_SCORE",
    distancePenaltyWeight: "DISTANCE_PENALTY_WEIGHT", overloadPenalty: "OVERLOAD_PENALTY",
    efficiencyThreshold: "EFFICIENCY_THRESHOLD", iliyaPitstopRadius: "ILIYA_PITSTOP_RADIUS",
    overloadTimeWeight: "OVERLOAD_TIME_WEIGHT", deficitRatioBonus: "DEFICIT_RATIO_BONUS",
    emergencyBonus: "EMERGENCY_BONUS", preservationBonus: "PRESERVATION_BONUS",
    westBias: "WEST_BIAS", useClustering: "USE_CLUSTERING"
  };
  for (const [key, target] of Object.entries(mappings)) if (tuning[key] !== undefined) APP_CONFIG[target] = tuning[key];
  if (tuning.tierPriority) APP_CONFIG.TIER_PRIORITY = { ...tuning.tierPriority };
  if (tuning.excludeSurplus) APP_CONFIG.EXCLUDE_SURPLUS = { ...tuning.excludeSurplus };
  for (const key of Object.keys(islandCoordinates)) delete islandCoordinates[key];
  Object.assign(islandCoordinates, rawData, navigation.coords || {});
  routeCalibrations = { ...defaultRouteCalibrations, ...(navigation.routeCalibrations || {}) };
  window.routeCalibrations = routeCalibrations;
};
window.applyBdoPersistentConfig({});
/* SPEC-005 T002 FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
function getItemTier(itemName) {
    if (!itemName) return 0; 
    let cleanName = itemName.replace(/\[.*?\]\s*/g, '').trim();
    // 1단부터 7단까지 마스터 DB에서 이름을 검색하여 티어 반환
    for(let i=1; i<=7; i++) { 
        if(masterData[i] && masterData[i].some(x => x.name === cleanName)) return i; 
    }
    if(cleanName.includes("진주 결정") || cleanName.includes("암염 주괴") || cleanName.includes("코발트 주괴") || cleanName.includes("오킬루아의 꽃") || cleanName.includes("파도의 블랙스톤") || cleanName.includes("대양의 견고한 현철") || cleanName.includes("유실된 무역품 상자")) return 'mat';
    if(cleanName.includes("까마귀 주화")) return 'coin';
    return 0; 
}

function getItemWeight(tier, itemName = "") {
    if (tier === 0 || tier === 'mat') {
        const cleanName = String(itemName).replace(/\[.*?\]\s*/g, '').replace(/\s+/g, '');
        return masterData[tier].find(item => item.name.replace(/\s+/g, '') === cleanName)?.weight ?? NaN;
    }
    if (tier === 1) return APP_CONFIG.WEIGHT.T1;
    if (tier === 2) return APP_CONFIG.WEIGHT.T2;
    if (tier === 3) return APP_CONFIG.WEIGHT.T3;
    if (tier === 4 || tier === 5) return APP_CONFIG.WEIGHT.T4;
    if (tier === 6) return APP_CONFIG.WEIGHT.T6 || 2000; // 6단 2000LT 추가
    if (tier === 7) return APP_CONFIG.WEIGHT.T7 || 2000; // 7단 2000LT 추가
    if (tier === 'coin') return APP_CONFIG.WEIGHT.COIN;
    return APP_CONFIG.WEIGHT.BASE; 
}
// DOMAIN_CONSTANTS_MIGRATED: classic-script globals preserve the reference execution environment.
