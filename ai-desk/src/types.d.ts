// wrangler는 .html 파일을 글(Text) 모듈로 묶습니다.
declare module "*.html" {
  const content: string;
  export default content;
}
