import argparse
import re
from urllib.parse import unquote
from configuration import durable_path
parser = argparse.ArgumentParser(description="Check local Markdown link targets in the supplied documents.")
parser.add_argument('documents', nargs='+')
args = parser.parse_args()
files=[durable_path(file) for file in args.documents]
count=0
for file in files:
 for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)",file.read_text()):
  target=target.strip("<>").split("#",1)[0]
  if not target or "://" in target or target.startswith("mailto:"):continue
  assert (file.parent/unquote(target)).resolve().exists(),(str(file),target)
  count+=1
print({"documents":len(files),"local_links_checked":count})
