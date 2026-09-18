# EXIF Databack

인스타 스토리용 필름 데이터백 각인 웹앱. 사진을 올리면 EXIF에서 촬영 날짜를 뽑아
7-세그먼트 앰버 각인을 사진에 태운다.

전체 맥락·결정사항·미해결 이슈는 **CLAUDE.md** 참고.

## 로컬 실행

```bash
npm install
npm run dev        # http://localhost:5173
```

## 빌드

```bash
npm run build      # dist/ 생성
npm run preview    # 빌드 결과 미리보기
```

## Vercel 배포

방법 A — CLI:
```bash
npm i -g vercel
vercel             # 최초 1회 프로젝트 연결
vercel --prod      # 프로덕션 배포
```

방법 B — GitHub 연동:
1. 이 폴더를 GitHub 레포로 push
2. vercel.com에서 New Project → 레포 선택
3. Framework 자동감지(Vite), 그대로 Deploy
4. 이후 push마다 자동 배포

빌드 설정(자동 감지됨): Build Command `npm run build`, Output Directory `dist`.

## 로고 에셋

`public/maker/*.png` 는 제조사 공식 로고 아트워크 21종이다.
[yurucam/exif-frame](https://github.com/yurucam/exif-frame) (GPL-3.0) 의
`web/public/maker/light` 세트를 가져왔다.

각 로고의 상표권은 해당 제조사에 있고, 여기서는 촬영 기기를 가리키는 용도로만 쓴다.
공개 배포나 상업적 사용을 고려한다면 GPL-3.0 의무와 상표 사용을 따로 확인할 것.
로고 파일을 지우면 앱은 자동으로 브랜드명 워드마크로 대체한다.
