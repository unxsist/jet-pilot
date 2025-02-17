const template = `apiVersion: 
kind: {{kind}}
metadata:
  name: new-{{name}}
  namespace: {{namespace}}
`;

export default template;
