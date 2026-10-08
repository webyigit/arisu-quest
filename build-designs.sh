#!/bin/sh
# 디자인 시안 v1~v10: 배포본(_site/index.html)을 복사해 themes/vN.css를 덧씌운 페이지를 _site/vN/에 만든다
set -e
mkdir -p _site/themes
cp themes/*.css _site/themes/
for n in 1 2 3 4 5 6 7 8 9 10; do
  mkdir -p "_site/v$n"
  sed -e 's#src="app.js#src="../app.js#; s#src="config.js#src="../config.js#; s#href="manifest.webmanifest"#href="../manifest.webmanifest"#; s#href="icon.svg"#href="../icon.svg"#' \
      -e "s#</head>#<link rel=\"stylesheet\" href=\"../themes/v$n.css?v=${GITHUB_SHA:-dev}\">\n</head>#" _site/index.html > "_site/v$n/index.html"
done
