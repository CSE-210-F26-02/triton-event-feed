
import json
import subprocess
import re

def get_issues():
    result = subprocess.run(
        [
            "gh", "issue", "list",
            "--state", "all",
            "--limit", "1000",
            "--json",
            "number,title,body,state,labels,createdAt,updatedAt"
        ],
        capture_output=True,
        text=True,
        check=True
    )
    return json.loads(result.stdout)


def anonymize(text):
    if not text:
        return ""

    # Remove email addresses
    text = re.sub(
        r'\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b',
        '[EMAIL REDACTED]', text
    )

    # Remove GitHub usernames
    text = re.sub(
        r'(?<![\w/])@[A-Za-z0-9-]+',
        '[USER REDACTED]', text
    )

    return text


def main():
    issues = get_issues()
    output = []

    for index, issue in enumerate(issues, 1):
        output.append({
            "id": f"ISSUE-{index}",
            "title": anonymize(issue["title"]),
            "body": anonymize(issue["body"]),
            "state": issue["state"],
            "labels": [
                label["name"]
                for label in issue["labels"]
            ],
            "created_at": issue["createdAt"],
            "updated_at": issue["updatedAt"]
        })

    with open(
        "issues_anonymized.json",
        "w",
        encoding="utf-8"
    ) as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Exported {len(output)} anonymized issues.")


if __name__ == "__main__":
    main()
