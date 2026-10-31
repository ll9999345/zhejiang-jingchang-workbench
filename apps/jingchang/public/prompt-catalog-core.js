export const PROMPT_SYSTEM_CATEGORIES=[{id:'view',name:'视角'},{id:'storyboard',name:'分镜'},{id:'character',name:'角色'},{id:'product',name:'产品'},{id:'lighting',name:'光影'},{id:'custom',name:'我的'}];
// Original wording for this product. Reference projects supplied use cases, not
// these templates. Suggestions remain human-readable; no model is called here.
const seed=[
 ['views-nine','九宫格机位参考','view','围绕{{subject}}制作3×3机位参考图。九个画面分别采用正面、侧面、背面、左右四分之三、俯视、仰视、近景和环境全景。保持主体造型、道具、布光与背景一致，构图清楚，边缘自然。','多机位参考与场景勘察'],
 ['views-nine-detail','九宫格细节参考','view','为{{subject}}制作适合高分辨率输出的九宫格机位参考。先锁定外观、材质和尺度，再安排由全景到近景的不同观察方向；各格保留可辨认的纹理、自然的阴影与一致的镜头质感。','高分辨率机位与材质参考'],
 ['story-four','四幅剧情分镜','storyboard','以{{subject}}为核心，把{{story}}表现为四幅连续分镜。依次交代起因、行动、变化和结果，让视线、人物位置和光线方向连贯，用景别变化表达情绪推进。','短段落叙事预览'],
 ['face-three','面部三视图','character','为{{subject}}绘制同一张角色面部参考图，分别展示正面、四分之三和侧面。面部比例、发际线、肤色与表情保持一致，使用均匀柔光与简单背景，保留真实的结构细节。','角色面部一致性'],
 ['product-three','产品三视图','product','表现{{subject}}的正面、侧面和顶面。保持同一产品的尺寸关系、材质、颜色、结构和配件，不增加不存在的部件；背景干净，以均匀光线清楚呈现轮廓。','产品展示与结构核对'],
 ['story-twentyfive','二十五幅连贯分镜','storyboard','将{{story}}整理为5×5共二十五幅连续分镜，主体为{{subject}}。覆盖开场、展开、推进、转折、高潮、回落和收束；相邻画面动作与空间承接清楚，主体设计和环境光线一致。','长段落分镜预览'],
 ['light-six','六种电影光线','lighting','固定{{subject}}的构图、姿态与镜头，分别尝试暖色逆光、阴天柔光、侧面硬光、夜景彩光、低调轮廓光和窗边自然光。只改变光照条件，清楚表现每种光线带来的层次与情绪。','布光方案比较'],
 ['character-sheet','角色设定参考表','character','为{{subject}}制作角色设定表：一幅面部与胸像近景，以及正面、侧面和背面的全身参考。统一身高比例、发型、服装、配饰、色彩和材质，清晰呈现设计中的关键特征。','角色完整外观设定'],
 ['expressions-six','六种表情参考','character','以同一位{{subject}}制作2×3表情参考，分别表现平静、愉快、惊讶、忧虑、愤怒和悲伤。固定镜头、发型、服装和光线，以自然的面部肌肉变化表达情绪，不改变身份特征。','表情和人物一致性'],
 ['panorama-full','完整空间全景','view','创作{{subject}}的等距柱状全景参考，画面覆盖完整空间。左右边界应自然衔接，地面、天花或天空的透视保持连续，主体尺度、地平线和光照方向统一，避免拼接断层。','环视空间与全景制作']
];
export function originalPromptPresets(){const time='2026-10-18T16:00:00.000Z';return seed.map(([id,title,category,text,scene])=>{const fields={title,text,category,negative:'画面中的无关文字、水印、重复主体、结构变形、材质漂移、光照矛盾和拼接断层。',scene};return{id:'jingchang-preset-'+id,...fields,revision:1,createdAt:time,updatedAt:time,catalogOrigin:{libraryId:'system',categoryId:category},preset:true,versions:[{revision:1,...fields,createdAt:time}]};});}
